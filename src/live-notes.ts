/**
 * The steering notes that belong in one run's live conversation
 * (docs/plans/live-conversation.md §5): every note this run reached —
 * attached to its brief, mailed into its folder, or read by it, as kept in
 * steer_note_run when it happened — and, only while this run is the task's
 * live build, notes still waiting for it. A note never shows on a run it did
 * not reach, and is credited as read only to the run that read it.
 */
import { steerStandingParts } from "./steer-status.js";
import type { SteerNote, Store } from "./store.js";

export const RUN_NOTES_SHOWN = 20;

export type RunNote = {
  id: number;
  author: string;
  /** Whether the person looking wrote it: only then does the view say "You". */
  mine: boolean;
  at: string;
  text: string;
  standing: string;
  readAt: string | null;
};

/** Where a note stands as seen from this run. */
function standingFor(note: SteerNote, run: number, live: boolean): { standing: string; readAt: string | null } {
  if (note.authorshipState === "verified" && note.supersededAt === null && note.deliveredAt === null && !live) {
    // This run ended (or is not the one reading notes) without reading it: it waits for the next attempt.
    return { standing: "Not read in this attempt — the next one gets it", readAt: null };
  }
  // Once read, a note's attached run is the run that read it (ackSteerNote, settleSteerDelivered).
  if (note.deliveredAt !== null && note.attachedRun !== run) return { standing: "Read in another attempt", readAt: null };
  const { words, readAt } = steerStandingParts(note, live);
  return { standing: words, readAt };
}

/** This run's notes, oldest first: the newest RUN_NOTES_SHOWN, and how many older ones the task page keeps. */
export function runNotes(store: Store, run: { id: number; taskRef: number }, viewer: string, now: Date): { notes: RunNote[]; older: number } {
  const live = store.steeringLiveBuild(run.taskRef, now) === run.id;
  const reached = new Map(store.steerNotesReaching(run.id).filter(note => note.taskRef === run.taskRef).map(note => [note.id, note]));
  if (live) {
    for (const note of store.listSteerNotes(run.taskRef)) {
      const waiting = note.authorshipState === "verified" && note.deliveredAt === null && note.supersededAt === null;
      if (waiting && !reached.has(note.id)) reached.set(note.id, note);
    }
  }
  const all = [...reached.values()].sort((a, b) => a.id - b.id);
  const shown = all.slice(-RUN_NOTES_SHOWN);
  return {
    older: all.length - shown.length,
    notes: shown.map(note => ({
      id: note.id,
      author: note.author,
      mine: note.author === viewer,
      at: note.createdAt,
      text: note.note,
      ...standingFor(note, run.id, live),
    })),
  };
}
