/**
 * What a running attempt can be told and done to, in one place (docs/plans/agents-cockpit.md §4, R10): every live
 * view of an attempt offers exactly these, and says plainly what is missing. Each answer is derived from the same facts
 * the store's own gates read (steeringLiveBuild / liveInputRun for notes and pauses, requestRunStop's rules for Stop),
 * so the view never offers what the store would refuse.
 *
 *   Builder with live input (Claude, on this computer's runner)  notes reach it at once · pause/resume · stop
 *   Any other builder (Codex, OpenRouter, Gemini, ACP; another computer's runner relays)  notes by mailbox while it is
 *     open, read at its next check; before it starts, in its brief · stop
 *   A builder past its mailbox (finishing, or repairing its handoff)  no notes for this attempt
 *   A protocol repair (a `repair` child of a builder), a planner's correction  no notes · Stop stops the owning attempt
 *   Planner, scout, reviewer  no notes (none reads a mailbox) · stop
 *
 * A repair *task* (a task filed to fix a result) runs as a builder, so it is the builder row.
 */
import type { Store } from "./store.js";

export type SteerSend = "live" | "mailbox";
export type SteerCapability = {
  /** How a note reaches this attempt; null: it takes none now. */
  send: SteerSend | null;
  /** Pause, resume, and pause-and-steer (live input only). */
  pause: boolean;
  /** The run a Stop names (the owning attempt for a child), and what the button says; null: the store would refuse. */
  stop: { run: number; label: string } | null;
  /** One plain sentence for the composer: how a note travels, or why there is none. */
  words: string;
};

const ROLE_WORDS: Record<string, string> = { planner: "planner", scout: "scout", reviewer: "reviewer" };

/** The attempt a run belongs to: up its parents while they share its claim (a protocol repair, a planner's correction). */
function ownerOf(store: Store, runId: number): number {
  let at = store.getRun(runId);
  for (let depth = 0; at !== null && at.parentRun !== null && depth < 16; depth++) {
    const parent = store.getRun(at.parentRun);
    if (parent === null || parent.leaseId !== at.leaseId) break;
    at = parent;
  }
  return at?.id ?? runId;
}

/** Whether a Stop of this run would be accepted now — requestRunStop's own rules, read without writing. */
function stoppable(store: Store, runId: number, now: Date): boolean {
  const run = store.getRun(runId);
  if (run === null) return false;
  if (store.stopOf(runId) !== null) return true; // asking again is the same stop
  if (run.outcome !== null) return false;
  if (run.role !== "reviewer" && store.currentLiveLease(run.taskRef, now) !== run.leaseId) return false;
  return store.publicationForRun(runId) === null;
}

/** The capability of this exact run, now. Null when it is not running. */
export function steerCapabilityOf(store: Store, runId: number, now: Date): SteerCapability | null {
  const run = store.getRun(runId);
  if (run === null || run.outcome !== null || run.finishedAt !== null) return null;
  const owner = ownerOf(store, run.id);
  const stopOf = (label: string) => stoppable(store, owner, now) ? { run: owner, label } : null;
  // A child of an attempt (a protocol repair, a planner's correction) is part of it: no notes, and Stop names the owner.
  if (owner !== run.id) {
    return { send: null, pause: false, stop: stopOf("Stop this attempt"),
      words: run.role === "repair" ? "It's repairing its handoff and reads no notes now. Stop this attempt to change its course."
        : "It's part of a larger attempt and reads no notes. Stop this attempt to change its course." };
  }
  const role = ROLE_WORDS[run.role];
  if (role !== undefined) return { send: null, pause: false, stop: stopOf("Stop"), words: `This ${role} can't take notes; stop it to change its course.` };
  if (run.role !== "builder") return null;
  const repairing = store.handle.prepare("SELECT 1 AS hit FROM run WHERE parent_run = ? AND role = 'repair' AND outcome IS NULL").get(run.id) !== undefined;
  if (repairing) return { send: null, pause: false, stop: stopOf("Stop this attempt"), words: "It's repairing its handoff and reads no notes now. Stop this attempt to change its course." };
  if (store.liveInputRun(run.taskRef, now) === run.id) return { send: "live", pause: true, stop: stopOf("Stop"), words: "Notes reach the agent right away." };
  if (store.steeringLiveBuild(run.taskRef, now) === run.id) return { send: "mailbox", pause: false, stop: stopOf("Stop"), words: "It reads notes at its next check." };
  // Not yet at work: a note filed now is in its brief when it starts. Past its mailbox: none reaches this attempt.
  const state = store.handle.prepare("SELECT phase, steer_opened_at FROM run WHERE id = ?").get(run.id);
  const starting = state !== undefined && state["phase"] == null && state["steer_opened_at"] == null && store.currentLiveLease(run.taskRef, now) === run.leaseId;
  if (starting) return { send: "mailbox", pause: false, stop: stopOf("Stop"), words: "It reads notes when it starts working." };
  // Never given a mailbox (steering off for it), or past it.
  if (state?.["steer_opened_at"] == null) return { send: null, pause: false, stop: stopOf("Stop"), words: "It doesn't read notes; anything you send waits for the next attempt." };
  return { send: null, pause: false, stop: stopOf("Stop"), words: "It has stopped reading notes; anything you send now waits for the next attempt." };
}
