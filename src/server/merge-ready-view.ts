/** The task page's "Can I merge?" panel (docs/plans/plain-toolroll.md P1.6): the checklist (merge-checklist.ts) with
 * each blocker's act as the form this page already posts for it. Run checks is the Checks row's own post; Retry is the
 * failed box's own requeue (the page shows it only where that box would); Ask the agent to fix is Send back: the same
 * post to /r/<build>/comment with intent=revise that the result's Send back makes, its note prefilled with the blocker
 * and editable, sealing the same saved notes. Only a signed-in approver gets the forms; anyone else reads the rows. */
import { randomBytes } from "node:crypto";
import type { AssignmentSnapshot } from "../assignment.js";
import type { MergeReadyAct, MergeReadyView } from "../browser-workspace.js";
import { checklistFromAssignment } from "../merge-checklist.js";
import { isRevisionFeedback, revisionBatchOf, revisionSourceOf } from "../result-review.js";
import type { Store } from "../store.js";
import type { Who } from "./session.js";

/** The panel for a task page, or null when there is no result to merge yet. */
export function mergeReadyViewOf(store: Store, taskId: string, assignment: AssignmentSnapshot | null | undefined, who: Who,
  runChecks: { action: string; level: "quick" | "full"; returnTo: string } | null, returnTo: string): MergeReadyView | null {
  if (assignment == null || assignment.receipt === null) return null;
  const list = checklistFromAssignment(store, taskId, assignment);
  const person = who.via === "cookie" && who.role === "approver" && !store.isDemo();
  const receipt = assignment.receipt;
  const notes = store.liveDiffComments(receipt.runId).filter(one => isRevisionFeedback(one));
  return {
    answer: list.answer, sentence: list.sentence,
    rows: list.rows.filter(one => one.mark !== "skip").map(one => {
      const act = one.act;
      const form: MergeReadyAct | null = !person || act === null ? null
        : act.kind === "run-checks" ? runChecks === null || runChecks.action !== `/r/${act.run}/checks` ? null : { kind: "run-checks", ...runChecks }
        : act.kind === "retry" ? { kind: "retry" }
        : act.run !== receipt.runId ? null
        : { kind: "fix", action: `/r/${act.run}/comment`, note: act.note, batch: revisionBatchOf(notes), source: revisionSourceOf(store.getScope(receipt.taskId)?.digest ?? null),
          request: randomBytes(16).toString("hex"), returnTo };
      return { key: one.key, label: one.label, mark: one.mark, say: one.say, act: form };
    }),
  };
}
