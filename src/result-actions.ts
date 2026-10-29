import { verifyResultImage } from "./chat-evidence.js";
/** Shared result-to-revision action for the result form and chat.
 * The caller authenticates; this service checks project access and the exact
 * displayed note batch, then uses the existing atomic revision/approval boundary.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Store, DiffComment } from "./store.js";
import { EVIDENCE_CAPS, readVerifiedArtifact, writeEvidenceFile } from "./evidence.js";
import { parseFeedbackImage, sameFeedbackImage, type FeedbackImage, isRevisionFeedback, parseRevisionBatch, revisionSourceOf, commentSourceKey, REQUEST_TOKEN } from "./result-review.js";
import { validateNote, hasForbiddenControls } from "./decision.js";
import { TASK_TEXT_LIMITS, validateTaskText } from "./task-text.js";
import { modeFilingCoverage } from "./scope.js";

export type RevisionResult = { ok: true; id: string } | { ok: false; status: number; message: string };
type RevisionInput = Parameters<typeof createResultRevision>[2];

/** Re-prove image custody and current result at each write. No file paths supplied by callers. */
export function feedbackImageProblem(store: Store, root: string, runId: number, image: FeedbackImage | null | undefined): string | null {
  if (image == null) return null;
  const parsed = parseFeedbackImage(image);
  if (!parsed || image.run !== runId) return "Choose a screenshot from this result. Your draft is unchanged.";
  const run = store.getRun(runId);
  const task = run === null ? null : store.externalIdFor(run.taskRef);
  const repo = run === null ? null : store.refById(run.taskRef)?.repo;
  if (!task || !repo) return "This screenshot is no longer available. Your draft is unchanged.";
  const family = store.taskFamilyOf(task, [repo], false);
  const latest = store.runsFor(run!.taskRef).find(one => ["builder", "repair", "scout"].includes(one.role) && one.outcome !== null);
  if (family?.problem !== null || family.current.id !== task || latest?.id !== runId) return "A newer result is current. Open it before commenting on a screenshot. Your draft is unchanged.";
  const verified = verifyResultImage(store, root, [repo], { taskId: task, ...image });
  return verified.ok ? null : "This screenshot is unavailable or changed. Restore it or remove it from your feedback. Your draft is unchanged.";
}

/** One user action: add the typed change and seal exactly the displayed
 * saved notes. A refusal rolls back the note; a replay returns the same task. */
export function requestResultChanges(store: Store, evidenceRoot: string, input: RevisionInput & {
  note: string; path: string; line: string; request: string | null; image?: FeedbackImage | null;
}, now: Date): RevisionResult {
  try {
    return store.transact(() => store.savepoint((): RevisionResult => {
      const fail = (status: number, message: string): never => { throw new ChangeRequestRefusal(status, message); };
      if (!input.note.trim()) {
        if (input.path.trim() || input.line.trim() || input.image != null) return fail(400, "Describe the change before attaching an image, file or line.");
        if (!input.batch) return fail(400, "Describe a change or use a saved note.");
        return createResultRevision(store, evidenceRoot, input, now);
      }
      const valid = validateNote(input.note);
      if (!valid.ok) return fail(400, valid.problem);
      if (input.request === null || !REQUEST_TOKEN.test(input.request)) return fail(400, "Reload the result before requesting changes. Your draft stays here.");
      const batch = input.batch === "" ? [] : parseRevisionBatch(input.batch);
      if (batch === null) return fail(400, "Reload the result to review the saved notes.");
      const path = input.path.trim() || null;
      const line = input.line.trim() === "" ? null : Number(input.line);
      if (path !== null && (path.length > 300 || hasForbiddenControls(path))) return fail(400, "Enter a file path of up to 300 characters, without control characters.");
      if (line !== null && (path === null || !Number.isInteger(line) || line < 1 || line > 1_000_000)) return fail(400, "Choose a file and a whole line number from 1 to 1,000,000.");
      const run = store.getRun(input.run);
      const repo = run === null ? null : store.refById(run.taskRef)?.repo ?? null;
      if (run === null || (repo === null ? input.includeUnplaced !== true : input.repos !== null && !input.repos.includes(repo))) return fail(404, "No such result.");
      const artifact = store.artifactsFor(run.id).find(one => one.kind === "terminal-diff");
      if (!artifact || !readVerifiedArtifact(evidenceRoot, artifact).ok) return fail(409, "The saved changes could not be verified. Restore the result before requesting changes.");
      const sourceKey = commentSourceKey(input.actor, input.request)!;
      const earlier = store.diffCommentBySourceKey(sourceKey);
      if (earlier && (earlier.run !== run.id || earlier.path !== path || earlier.line !== line || earlier.note !== valid.note || !sameFeedbackImage(earlier.image, input.image))) return fail(409, "This submission already saved different feedback. Reopen the result and try again.");
      // An exact consumed replay only returns its existing revision. Every new
      // use proves the image before insertion, so malformed targets refuse cleanly.
      if (earlier?.consumedBy == null) {
        const problem = feedbackImageProblem(store, evidenceRoot, run.id, input.image);
        if (problem !== null) return fail(409, problem);
      }
      const noteId = earlier?.id ?? store.addDiffComment({ artifactId: artifact.id, runId: run.id, path, line, note: valid.note, author: input.actor, sourceKey, image: input.image ?? null }, now);
      if (noteId === null) return fail(409, "This feedback changed while saving. Your draft is unchanged; reopen the result.");
      const result = createResultRevision(store, evidenceRoot, { ...input, batch: [...new Set([...batch, noteId])].sort((a, b) => a - b).join(",") }, now);
      if (!result.ok) return fail(result.status, result.message);
      return result;
    }));
  } catch (error) {
    if (error instanceof ChangeRequestRefusal) return { ok: false, status: error.status, message: error.message };
    throw error;
  }
}
class ChangeRequestRefusal extends Error { constructor(readonly status: number, message: string) { super(message); } }

export function createResultRevision(store: Store, evidenceRoot: string, input: {
  run: number; batch: string | null; source: string | null; actor: string;
  repos: readonly string[] | null; includeUnplaced?: boolean; allowMode?: boolean;
}, now: Date): RevisionResult {
  return store.transact((): RevisionResult => {
    const id = input.run;
    const visible = (repo: string | null) => repo === null ? input.includeUnplaced === true : input.repos === null || input.repos.includes(repo);
    const fail = (status: number, message: string): RevisionResult => ({ ok: false, status, message });
    const found = store.getRun(id);
    if (found === null || !visible(store.refById(found.taskRef)?.repo ?? null)) return fail(404, "No such result.");
    const sourceTaskId = store.externalIdFor(found.taskRef) ?? "?";
    const sourceScope = store.getScope(sourceTaskId);
    const sourceFamily = store.taskFamilyOf(sourceTaskId, input.repos, input.includeUnplaced ?? false);
    if (sourceFamily === null || sourceFamily.problem !== null) return fail(409, "The revision history cannot be verified in this project.");
    const repo = store.refById(found.taskRef)?.repo ?? null;
    // THE DISPLAYED BATCH (repair 2026-09-14, finding 2): the form names
    // the exact note ids its reader saw and the source terms it was
    // rendered against. The seal binds to those ids and nothing else —
    // "every live note at POST time" would let an old submission, a
    // replay, or a second tab consume notes its reader never displayed.
    const batchIds = parseRevisionBatch(input.batch);
    const postedSource = input.source;
    if (batchIds === null || postedSource === null || postedSource === "") {
      return fail(400, "this form is out of date — it names no note batch; reload the result and create the revision from the notes shown there");
    }
    const byId = new Map(store.allDiffComments(id).map(one => [one.id, one] as const));
    const named = batchIds.map(one => byId.get(one));
    if (named.some(one => one === undefined)) {
      return fail(400, "this batch names notes that are not on this result — reload the result");
    }
    const batch = named as DiffComment[];
    // A replay must match the immutable brief's entire batch and source,
    // not just a subset whose notes happen to name the same child. Read-only
    // replay can return its original child even after the source is rescoped.
    const replayChild = (notes: DiffComment[]): string | null => {
      const child = notes[0]?.consumedBy;
      if (!child || notes.length !== batchIds.length || notes.some(one => one.consumedBy !== child)) return null;
      const ref = store.lookupRef(child);
      const lineage = ref === null ? null : store.revisionSourceOf(ref.id);
      if (ref === null || !visible(ref.repo) || lineage === null || lineage.sourceRun !== id || lineage.sourceTask !== sourceTaskId) return null;
      try {
        const read = readVerifiedArtifact(evidenceRoot, lineage.briefArtifact);
        if (!read.ok) return null;
        const brief = JSON.parse(read.content.toString("utf8"));
        if (brief.sourceRun !== id || brief.sourceTask !== sourceTaskId || revisionSourceOf(brief.sourceScopeDigest) !== postedSource || !Array.isArray(brief.comments)) return null;
        return brief.comments.length === batchIds.length && brief.comments.every((one: { id: number }, at: number) => one.id === batchIds[at]) ? child : null;
      } catch {
        return null;
      }
    };
    // A retry of an OLD request: every note it names is already sealed
    // into one revision — that revision is the answer, and no note added
    // since is touched. A batch partly sealed elsewhere is refused whole.
    const consumers = new Set(batch.map(one => one.consumedBy).filter((one): one is string => one !== null));
    const replay = replayChild(batch);
    if (replay !== null) return { ok: true, id: replay };
    if (consumers.size > 0) {
      return fail(409, `some of these notes were already sealed into revision ${[...consumers].join(", ")}; the others are still waiting — reload the result to see the current batch`);
    }
    if (postedSource !== revisionSourceOf(sourceScope?.digest ?? null)) {
      return fail(409, "the task's terms changed since this page was shown — reload the result and read the current terms before creating a revision");
    }
    if (batch.some(one => one.supersededBy !== null)) {
      return fail(409, "a note in this batch was superseded — reload the result to see the current batch");
    }
    if (batch.some(one => !isRevisionFeedback(one))) return fail(409, "Review observations are not requested changes. Use Request change to add your feedback first.");
    for (const one of batch) {
      const problem = feedbackImageProblem(store, evidenceRoot, id, one.image);
      if (problem !== null) return fail(409, problem);
    }
    const comments = batch;
    // Keep the subject recognizable, including when revising a revision.
    // Reserve the suffix before truncating, at whole grapheme boundaries.
    const suffix = " — revision";
    const subject = (store.getTask(sourceTaskId)?.title ?? "").trim().replace(/(?: — revision)+$/u, "").trim() || "Task";
    let prefix = "";
    for (const { segment } of new Intl.Segmenter("en", { granularity: "grapheme" }).segment(subject)) {
      if ((prefix + segment + suffix).length > TASK_TEXT_LIMITS.title) break;
      prefix += segment;
    }
    const candidateTitle = `${prefix.trimEnd() || "Task"}${suffix}`;
    const title = validateTaskText({ title: candidateTitle }) === null ? candidateTitle : `Task${suffix}`;
    const feedbackKind = comments.every(one => one.path !== null) ? "annotations" : "feedback";
    const terminal = store.artifactsFor(id).find(one => one.kind === "terminal-diff");
    if (terminal !== undefined) {
      const proven = readVerifiedArtifact(evidenceRoot, terminal);
      if (!proven.ok) {
        return fail(409, `the reviewed diff no longer verifies (${proven.problem}) — the batch cannot seal against it`);
      }
    }
    // The brief is serialized and size-checked BEFORE anything is created
    // (Codex M5-M8 audit, IV-3): a structured artifact must never pass
    // through byte truncation — truncated JSON is not a smaller brief,
    // it is no brief wearing one's name.
    const brief = {
      schema: 1 as const,
      sourceTask: sourceTaskId,
      sourceRun: id,
      sourceScopeDigest: sourceScope?.digest ?? null,
      head: found.headRevision,
      diffArtifactSha: terminal?.sha256 ?? null,
      comments: comments.map(one => ({
        id: one.id,
        path: one.path,
        line: one.line,
        note: one.note,
        author: one.author,
        createdAt: one.createdAt,
        ...(one.image == null ? {} : { image: one.image }),
      })),
    };
    const briefBytes = Buffer.from(JSON.stringify(brief, null, 2), "utf8");
    if (briefBytes.length > EVIDENCE_CAPS["revision-brief"]) {
      return fail(400, "this batch is too large for one brief — seal it in parts");
    }
    // The file first, under a nonce name — a file whose seal fails is an
    // orphan on disk, never authority. Then ONE transaction: task with
    // the source scope's limits INHERITED (audit IV-2 — a revision that
    // drops the exclusions is an approval screen telling a lie), the
    // artifact row, the relation, and exactly this comment batch.
    const briefName = `revision-brief-${randomBytes(6).toString("hex")}.json`;
    const key = writeEvidenceFile(evidenceRoot, id, briefName, briefBytes);
    // C1's revision arm: when the SEALER is the mode's signer and the
    // mode auto-approves their filings, the revision task approves
    // inside the same transaction, with mode provenance. Everything
    // else about the seal is unchanged; without coverage, the revision
    // keeps its own approval ceremony.
    const sealed = store.transact(() => {
      // Coverage first (cookie road only): its budget and escalated
      // posture ride the FILING so the digest binds them (surfaces
      // round 1, finding 2) — never a stamp after the fact.
      const coverage = input.allowMode === true ? modeFilingCoverage(store, repo, input.actor, now) : null;
      // ONE revision boundary (contract handoff task 2): the source's
      // goal, exclusions, touches, rubric, risk, quality, posture,
      // budget, overrides and pins are read from the SOURCE ROWS inside
      // the seal, which re-proves the task/run/scope-digest binding and
      // the brief's custody first — the scope read above only names the
      // digest this batch was drafted against.
      const result = store.sealRevision(
        {
          source: { task: sourceTaskId, run: id, scopeDigest: sourceScope?.digest ?? null },
          brief: { evidenceRoot, key, sha256: createHash("sha256").update(briefBytes).digest("hex"), bytes: briefBytes.length, capture: "machine-authored revision brief (exit 0)" },
          child: {
            title: `Revise ${sourceTaskId} from ${comments.length} annotation${comments.length === 1 ? "" : "s"} on build #${id}`,
            repair: `apply the ${feedbackKind} recorded on build #${id}; the revision brief carries the exact batch`,
          },
          commentIds: comments.map(one => one.id),
          coverage,
          requestedBy: input.actor,
        },
        now,
      );
      if (result.ok) {
        // The unchanged legacy title above feeds the store's existing slug
        // and collision handling. Set only this new row's display title,
        // atomically with its seal; retries returned earlier, untouched.
        store.raw().prepare("UPDATE task SET title = ? WHERE id = ?").run(title, result.id);
      }
      // Planned afresh: the planner reads the copied terms and these notes, and a note asking for
      // more than the old plan allows becomes an amendment the person approves before anything
      // builds. Under a live mode the filing is approved at once instead, as every signer filing
      // is; revisions never inherit the mode's planner authority (docs/AUTO_APPROVAL.md).
      if (result.ok && coverage === null) {
        const ref = store.lookupRef(result.id);
        if (ref !== null) store.requestPlan(ref.id, now);
      }
      if (result.ok && coverage !== null) {
        // A scope whose profile could not resolve is unapprovable by the
        // human road (approve() refuses) — the mode road refuses too.
        const filedScope = store.getScope(result.id);
        if (filedScope?.profileState === "resolved") {
          // A false answer here is the coordinator quarantine (review
          // finding 7): the revision stays honestly unapproved and the
          // task page it redirects to says so in the quarantine words.
          void store.sealScopeApproval(result.id, input.actor, now, {}, { kind: "mode", modeDigest: coverage.digest });
        }
      }
      return result;
    });
    if (!sealed.ok) {
      // Two sealers of one batch race on the consumption count; the
      // loser is sent to the winner's revision — the one that consumed
      // EXACTLY this batch, never merely the newest child of the run — so
      // a double click or a two-tab submission lands on ONE revision.
      if (sealed.reason === "duplicate" || sealed.reason === "comments-taken") {
        const settled = store.allDiffComments(id).filter(one => batchIds.includes(one.id));
        const takers = new Set(settled.map(one => one.consumedBy).filter((one): one is string => one !== null));
        const winner = replayChild(settled);
        if (winner !== null) return { ok: true, id: winner };
        if (takers.size > 0) {
          return fail(409, `some of these notes were just sealed into revision ${[...takers].join(", ")}; the others are still waiting — reload the result to see the current batch`);
        }
      }
      return fail(409, `could not seal the revision: ${sealed.detail}`);
    }
    return { ok: true, id: sealed.id };

  });
}
