/**
 * Live steering's dispatcher: the builder runs one tick every half second
 * while its agent works, independent of the 60-second lease pulse.
 *
 * - Every provider: what the agent moved to handled/ is recorded read, and a
 *   note filed since the last tick is written to the steering folder at once
 *   (steer-mailbox.ts). Codex reads it there.
 * - A Claude build with live input (live-input.ts) also gets each note on
 *   stdin as soon as it is in the folder, each Pause as an interrupt and
 *   each Resume as a short continue frame — pauses first, so Pause and steer
 *   stops the turn before the note arrives.
 * - A note the agent has not moved to handled/ is followed up every 90
 *   seconds, up to 3 times, with a short reminder naming its file — never
 *   the note again, so an agent that already acted on it does not redo the
 *   work; 90 seconds after the last one it reads Not picked up. A paused
 *   session is not reminded: only a new note or Resume continues it. Moving
 *   the file is still the only proof of reading, and a note still unread
 *   when the attempt ends reaches the next attempt's brief as before.
 *
 * Every step is bookkeeping: a failure waits for the next tick and never
 * touches the build.
 */
import { randomUUID } from "node:crypto";
import { fence } from "./brief-fence.js";
import type { LiveInput } from "./live-input.js";
import { pulseSteerMailbox, STEER_HANDLED, steerNoteName, type SteerMailbox } from "./steer-mailbox.js";
import type { SteerNote, Store } from "./store.js";

/** How often the dispatcher looks: a note reaches a running Claude build within about this long. */
export const LIVE_TICK_MS = 500;
/** How long an unread note waits before it is sent again. */
export const LIVE_RESEND_MS = 90_000;
/** How many times an unread note is sent again before it reads Not picked up. */
export const LIVE_RESENDS = 3;

export type LiveSteer = { box: SteerMailbox; session: LiveInput | null };

/** The stdin copy of a note: the same fenced text and key as its file, and what to do with the file. */
export function liveNoteText(box: SteerMailbox, number: number, note: SteerNote): string {
  const name = steerNoteName(number);
  return [
    `Operator steering note ${number}, key ${box.key}, also saved as ${box.folder}/${name}:`,
    fence(note.note),
    `Act on it within the agreed scope, under the brief's rules for steering notes, then move ${box.folder}/${name} into ${box.folder}/${STEER_HANDLED}/ — moving the file is how the operator learns you read it.`,
  ].join("\n");
}

/** A re-send: only the note's number and file, and what to do with it. The note itself was sent in full once. */
export function liveReminderText(box: SteerMailbox, number: number): string {
  const name = steerNoteName(number);
  return `Steering note ${number} is still unread: ${box.folder}/${name}. Act on it if you have not already, then move it into ${box.folder}/${STEER_HANDLED}/.`;
}

/** One tick. `agentRunning`: the agent process is up, so a note written now can be read. */
export function tickLiveSteer(store: Store, steer: LiveSteer, now: Date, agentRunning: boolean): void {
  const { box, session } = steer;
  pulseSteerMailbox(store, box, now, agentRunning);
  if (session === null || !session.open || !agentRunning) return;
  for (const pause of store.unsentPauses(box.runId)) {
    const sent = session.interrupt(pause.requestId);
    if (sent === "closed") {
      store.endPause(pause.id, now);
      continue;
    }
    store.markPauseSent(pause.id, now);
    if (sent === "idle") store.markRunPaused(box.runId, now);
  }
  for (const resume of store.unsentResumes(box.runId)) {
    const sent = session.resume(randomUUID());
    if (sent === "sent") store.markResumeSent(resume.id, box.runId, now);
    else store.endResume(resume.id, now);
  }
  for (const [number, noteId] of [...box.waiting].sort((a, b) => a[0] - b[0])) {
    const note = store.steerNote(noteId);
    if (note === null || note.mailedRun !== box.runId || note.deliveredAt !== null || note.supersededAt !== null || note.liveMissedAt !== null) continue;
    const first = note.liveSends === 0;
    if (!first) {
      // A paused session waits for a new note; an old one sent again would continue it.
      if (session.paused) continue;
      if (note.liveSentAt === null || now.getTime() - Date.parse(note.liveSentAt) < LIVE_RESEND_MS) continue;
      if (note.liveSends > LIVE_RESENDS) {
        store.markLiveMissed(noteId, box.runId, now);
        continue;
      }
    }
    // The first send is the note itself, under its own identity; a re-send is a fresh frame (the harness may drop a
    // repeated uuid) that only names the file.
    if (!session.send(first ? liveNoteText(box, number, note) : liveReminderText(box, number), first ? (note.liveUuid ?? randomUUID()) : randomUUID())) return;
    store.recordLiveSend(noteId, box.runId, now);
    if (first) store.markRunResumed(box.runId, now);
  }
}
