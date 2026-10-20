/**
 * The composer's facts for one running attempt, for whichever surface shows it (the Agents board, a task page, a flow
 * card's task): what the attempt takes (steer-capabilities.ts), and the exact run each form names. One helper, so every
 * surface offers the same acts for the same attempt (docs/plans/agents-cockpit.md §4).
 */
import { randomUUID } from "node:crypto";
import type { BrowserAgentControls } from "./browser-workspace.js";
import { steerCapabilityOf } from "./steer-capabilities.js";
import type { Store } from "./store.js";

const taskHrefOf = (taskId: string) => `/t/${encodeURIComponent(taskId)}`;

/** The attempt running for a task now (any role, under the task's live claim; a child shows as its owner's own). */
export function liveAttemptOf(store: Store, taskRef: number, now: Date): number | null {
  const lease = store.currentLiveLease(taskRef, now);
  if (lease === null) return null;
  const row = store.handle.prepare("SELECT id FROM run WHERE task_ref = ? AND lease_id = ? AND outcome IS NULL AND finished_at IS NULL ORDER BY id DESC LIMIT 1").get(taskRef, lease);
  return row === undefined ? null : Number(row["id"]);
}

/** One running attempt's composer: the note's target (null: it takes none now) and its controls. Null when it is not
 * running, or this person may not act on it (a viewer, the demo). */
export function steerControlsFor(store: Store, taskId: string, runId: number, now: Date, canAct: boolean): { steer: { action: string; run: number } | null; controls: BrowserAgentControls } | null {
  if (!canAct || store.isDemo()) return null;
  const capability = steerCapabilityOf(store, runId, now);
  if (capability === null) return null;
  const href = taskHrefOf(taskId);
  const pause = capability.pause ? (() => {
    const state = store.livePauseOf(runId);
    const until = state?.pausedAt == null || state.limitMs === null ? null : new Date(Date.parse(state.pausedAt) + state.limitMs).toISOString();
    // Each form its own request id, so a repeated submit is the same request and two forms never collide.
    return { action: `${href}/pause`, run: runId, state: state?.state ?? null, requests: [`web-${randomUUID()}`, `web-${randomUUID()}`, `web-${randomUUID()}`] as [string, string, string], until };
  })() : null;
  return {
    steer: capability.send === null ? null : { action: `${href}/steer`, run: runId },
    controls: { send: capability.send, words: capability.words, pause, stop: capability.stop === null ? null : { action: `${href}/stop`, ...capability.stop } },
  };
}
