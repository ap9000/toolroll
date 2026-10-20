/**
 * The agent states' words, tones and counts (docs/plans/agents-cockpit.md §1), with nothing the browser can't load:
 * agent-state.ts derives the states; the console's pages and the sidebar say them with these.
 */
/** The display states, strongest first: a roll-up takes the first one any member has. */
export const DISPLAY_STATES = ["needs-you", "failed", "stuck", "paused", "working", "waiting", "done", "idle"] as const;
export type DisplayState = (typeof DISPLAY_STATES)[number];

export const STATE_WORDS: Record<DisplayState, string> = {
  "needs-you": "Needs you", failed: "Failed", stuck: "Stuck", paused: "Paused", working: "Working", waiting: "Waiting", done: "Done", idle: "Idle",
};
/** For someone who may not act on it: the obligation is still there, and still counts. */
export const NEEDS_SOMEONE = "Needs someone";
/** Each state's tone, for the console's one palette (attention, problem, live, ready, done, muted). */
export const STATE_TONE: Record<DisplayState, "attention" | "problem" | "live" | "ready" | "done" | "muted"> = {
  "needs-you": "attention", failed: "problem", stuck: "problem", paused: "muted", working: "live", waiting: "muted", done: "ready", idle: "muted",
};

export type StateCounts = Record<DisplayState, number>;
export const NO_COUNTS: StateCounts = Object.freeze({ "needs-you": 0, failed: 0, stuck: 0, paused: 0, working: 0, waiting: 0, done: 0, idle: 0 });

/** The strongest state among counts, and the counts themselves. Nothing counted is idle. */
export function rollUp(counts: StateCounts): { state: DisplayState; counts: StateCounts } {
  return { state: DISPLAY_STATES.find(state => state !== "idle" && counts[state] > 0) ?? "idle", counts };
}
