/**
 * What a running attempt can be told and done to, in one place (docs/plans/agents-cockpit.md §4, R10): every live
 * view of an attempt offers exactly these, and says plainly what is missing.
 *
 *   Builder with live input (Claude, on this computer's runner)  notes reach it at once · pause/resume · stop
 *   Any other builder (Codex, OpenRouter, Gemini, ACP; another computer's runner relays)  notes by mailbox, read at its
 *     next check · stop
 *   A protocol repair (a `repair` child of a builder) — and its builder while it runs  no notes (its brief reads none,
 *     and the builder's mailbox is closed first) · Stop stops the owning attempt
 *   Planner, scout, reviewer  no notes (none reads a mailbox) · stop
 *
 * A repair *task* (a task filed to fix a result) runs as a builder, so it is the builder row.
 */
import type { Store } from "./store.js";

export type SteerSend = "live" | "mailbox";
export type SteerCapability = {
  /** How a note reaches it; null: it takes none. */
  send: SteerSend | null;
  /** Pause, resume, and pause-and-steer (live input only). */
  pause: boolean;
  /** The run a Stop names (the owning attempt for a repair), and what the button says; null: nothing to stop. */
  stop: { run: number; label: string } | null;
  /** One plain sentence for the composer: how a note travels, or why there is none. */
  words: string;
};

const ROLE_WORDS: Record<string, string> = { planner: "planner", scout: "scout", reviewer: "reviewer" };

/** The capability of this exact run, now. Null when it is not running. */
export function steerCapabilityOf(store: Store, runId: number, now: Date): SteerCapability | null {
  const run = store.getRun(runId);
  if (run === null || run.outcome !== null || run.finishedAt !== null) return null;
  // A protocol repair is part of its builder: neither takes notes while it runs, and Stop names the builder.
  const owner = run.role === "repair" ? run.parentRun : run.id;
  const repairing = run.role === "repair" || store.handle.prepare("SELECT 1 AS hit FROM run WHERE parent_run = ? AND role = 'repair' AND outcome IS NULL").get(run.id) !== undefined;
  if (repairing && owner !== null) {
    return { send: null, pause: false, stop: { run: owner, label: "Stop this attempt" },
      words: "It's repairing its handoff and reads no notes now. Stop this attempt to change its course." };
  }
  const role = ROLE_WORDS[run.role];
  if (role !== undefined) return { send: null, pause: false, stop: { run: run.id, label: "Stop" }, words: `This ${role} can't take notes; stop it to change its course.` };
  if (run.role !== "builder") return null;
  const live = store.liveInputRun(run.taskRef, now) === run.id;
  if (live) return { send: "live", pause: true, stop: { run: run.id, label: "Stop" }, words: "Notes reach the agent right away." };
  return { send: "mailbox", pause: false, stop: { run: run.id, label: "Stop" }, words: "It reads notes at its next check." };
}
