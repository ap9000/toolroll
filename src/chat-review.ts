import type { Store } from "./store.js";
import type { VerifiedApprover } from "./principal.js";
import { selectResultImages } from "./chat-evidence.js";
import { readVerifiedArtifact } from "./evidence.js";
import { hasForbiddenControls, validateNote } from "./decision.js";
import { parseFeedbackImage, type FeedbackImage, isRevisionFeedback, revisionSourceOf } from "./result-review.js";
import { createResultRevision, feedbackImageProblem } from "./result-actions.js";

export type ReviewSnapshot = {
  task: string; root: string; execution: string; run: number; artifact: number;
  sha: string; source: string; title: string;
  images?: FeedbackImage[];
  notes: { id: number; note: string; path: string | null; line: number | null; image?: FeedbackImage | null }[];
};
type Problem = { ok: false; message: string };

/** Read precisely the result named, never silently substitute a newer version. */
export function readChatResult(store: Store, who: VerifiedApprover, evidenceRoot: string | undefined, task: string, run?: number):
  { ok: true; snapshot: ReviewSnapshot } | Problem {
  const ref = store.lookupRef(task);
  if (ref?.repo == null || !who.repos.includes(ref.repo)) return { ok: false, message: "That task is not in your projects." };
  const family = store.taskFamilyOf(task, who.repos, false);
  if (family === null || family.problem !== null) return { ok: false, message: "This task's revision history needs repair." };
  const found = run === undefined
    ? store.runsFor(ref.id).find(one => (one.role === "builder" || one.role === "repair") && one.outcome !== null)
    : store.getRun(run);
  if (found == null || found.taskRef !== ref.id || found.outcome === null) return { ok: false, message: "There is no finished result for that version yet." };
  const artifact = store.artifactsFor(found.id).find(one => one.kind === "terminal-diff");
  if (artifact === undefined || evidenceRoot === undefined) return { ok: false, message: "The saved changes are unavailable. Feedback has not been added." };
  const proven = readVerifiedArtifact(evidenceRoot, artifact);
  if (!proven.ok) return { ok: false, message: "The saved changes could not be verified. Restore the result before adding feedback." };
  const images = selectResultImages(store, who, evidenceRoot, task, found.id);
  return { ok: true, snapshot: {
    task, root: family.root.id, execution: family.current.id, run: found.id,
    artifact: artifact.id, sha: artifact.sha256, source: revisionSourceOf(store.getScope(task)?.digest ?? null),
    title: store.getTask(task)?.title ?? task,
    images: images.ok ? images.selection.images.map(one => ({ run: found.id, artifact: one.artifact, sha256: one.sha256 })) : [],
    notes: store.liveDiffComments(found.id).filter(isRevisionFeedback).map(one => ({ id: one.id, note: one.note, path: one.path, line: one.line, image: one.image ?? null })),
  } };
}

export type ReviewRequest = { snapshot: ReviewSnapshot; operation: "note" | "revise"; note: string | null; path: string | null; line: number | null; notes: number[]; image?: FeedbackImage | null };

export function reviewInputProblem(note: string | null, path: string | null, line: number | null): string | null {
  if (note !== null) { const valid = validateNote(note); if (!valid.ok) return valid.problem; }
  if (path !== null && (path.length > 300 || path.trim() === "" || hasForbiddenControls(path))) return "Choose a valid file path.";
  if (line !== null && (path === null || !Number.isInteger(line) || line < 1 || line > 1_000_000)) return "Choose a file and a valid line number.";
  if (note === null && (path !== null || line !== null)) return "Write a note before attaching it to a file.";
  return null;
}

/** Chat and the result form write the same comments and call the same revision service.
 * A failed combined note+revision rolls back the note too; no half-completed action.
 */
export function applyChatReview(store: Store, who: VerifiedApprover, evidenceRoot: string, request: ReviewRequest, now: Date, allowMode: boolean):
  { ok: true; taskId: string; run: number; said: string } | Problem {
  try {
    return store.transact(() => store.savepoint(() => {
      const fail = (message: string): never => { throw new ReviewRefusal(message); };
      const { snapshot: saw, operation, note, path, line, notes } = request;
      const problem = reviewInputProblem(note, path, line);
      if (problem !== null) return fail(problem);
      const current = readChatResult(store, who, evidenceRoot, saw.task, saw.run);
      if (!current.ok) return fail(current.message);
      const live = current.snapshot;
      if (live.execution !== saw.execution || live.source !== saw.source || live.artifact !== saw.artifact || live.sha !== saw.sha) return fail("This result changed. Review it again before confirming.");
      if (operation === "revise" && saw.execution !== saw.task) return fail("A newer revision is current. Review that version before requesting changes.");
      if (!Array.isArray(notes) || new Set(notes).size !== notes.length || notes.some(id => !saw.notes.some(n => n.id === id) || !live.notes.some(n => n.id === id))) return fail("Some feedback changed or was already used. Review it again.");
      if (operation === "note" && (note === null || notes.length > 0)) return fail("A saved note needs feedback text and cannot consume other notes.");
      const image = parseFeedbackImage(request.image);
      if (image === false || (image !== null && note === null)) return fail("Choose a screenshot and write its feedback again.");
      const imageProblem = feedbackImageProblem(store, evidenceRoot, live.run, image);
      if (imageProblem !== null) return fail(imageProblem);
      const batch = [...notes].sort((a, b) => a - b);
      if (note !== null) {
        const id = store.addDiffComment({ artifactId: live.artifact, runId: live.run, path, line, note, author: who.name, image }, now);
        if (id === null) return fail("The note could not be saved.");
        batch.push(id);
      }
      if (operation === "note") return { ok: true as const, taskId: live.root, run: live.run, said: "Feedback saved. No work started." };
      if (batch.length === 0) return fail("Add feedback or select saved notes before requesting changes.");
      const result = createResultRevision(store, evidenceRoot, {
        run: live.run, batch: batch.join(","), source: live.source, actor: who.name, repos: who.repos, allowMode,
      }, now);
      if (!result.ok) return fail(result.message);
      const scope = store.getScope(result.id);
      const approved = scope?.approvedDigest != null && scope.approvedDigest === scope.digest;
      const planning = store.lookupRef(result.id)?.plan === "requested";
      return { ok: true as const, taskId: result.id, run: live.run,
        said: approved ? "Revision created under your automatic approval settings." : planning ? "Revision created. Updating the plan with your notes; you'll approve it next." : "Revision created. Review and approve it to start." };
    }));
  } catch (error) {
    if (error instanceof ReviewRefusal) return { ok: false, message: error.message };
    throw error;
  }
}
class ReviewRefusal extends Error {}
