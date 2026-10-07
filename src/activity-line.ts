/**
 * What a running agent did last, in one line (live tasks): "Ran a command ·
 * 40 s ago". Pure and shared: the server sends the facts, and each page words
 * them against its own clock, so the age keeps counting between reads.
 *
 * After five minutes with no word the line turns amber and says so; a worker
 * whose heartbeat stopped says that instead, because a quiet agent and a
 * machine that went away need different help.
 */

/** The facts behind the line: our own words for the last thing done (never a tool's arguments), when, and whether
 * the worker running it still answers. */
export type RunActivity = { what: string; at: string; worker: "online" | "offline" };

export const QUIET_AFTER_MS = 5 * 60_000;

/** The words for each fixed activity kind (live.ts's vocabulary) and for a progress checkpoint. */
export const ACTIVITY_WORDS: Readonly<Record<string, string>> = {
  session: "Started work",
  message: "Wrote an update",
  edit: "Edited files",
  command: "Ran a command",
  read: "Read the code",
  search: "Searched the code",
  lookup: "Looked something up",
  plan: "Updated its plan",
  delegate: "Handed a step to a helper",
  tool: "Used a tool",
  progress: "Reported progress",
  started: "Started",
};

/** "just now", "40 s ago", "3 min ago", "2 h ago". */
export function agoWords(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

/** The line itself, and whether it is quiet (amber): silent five minutes or more, or the worker is offline. */
export function activityLine(activity: RunActivity, now: number): { text: string; quiet: boolean } {
  const at = Date.parse(activity.at);
  const since = Number.isNaN(at) ? 0 : Math.max(0, now - at);
  if (activity.worker === "offline") return { text: `Worker offline · last word ${agoWords(since)}`, quiet: true };
  if (since >= QUIET_AFTER_MS) return { text: `No word for ${Math.floor(since / 60_000)} min`, quiet: true };
  return { text: `${activity.what} · ${agoWords(since)}`, quiet: false };
}
