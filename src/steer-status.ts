/**
 * Where a steering note stands, in the one set of words the task page, the
 * CLI and the lead all use (v120). A note is read only when the agent proves
 * it: the stream's receipt of a brief that quoted it, or the agent moving it
 * to handled/ in a running build's steering folder. Everything else is
 * either waiting for the agent that is running now, or for the next attempt.
 */
import type { SteerNote } from "./store.js";

export type SteerStanding = "read" | "waiting" | "not-picked-up" | "next-attempt" | "ended" | "unverified";

/** `liveBuild`: the task has a build whose agent is running and reads its steering folder (Store.steeringLiveBuild). */
export function steerStandingOf(note: SteerNote, liveBuild: boolean): SteerStanding {
  if (note.authorshipState !== "verified") return "unverified";
  if (note.supersededAt !== null) return "ended";
  if (note.deliveredAt !== null) return "read";
  if (!liveBuild) return "next-attempt";
  // Sent to the running build every time it was owed, and never moved to handled/ (steer-live.ts).
  return note.liveMissedAt !== null ? "not-picked-up" : "waiting";
}

/** The words, and the moment the agent read it when it has: each surface renders that time its own way. */
export function steerStandingParts(note: SteerNote, liveBuild: boolean): { words: string; readAt: string | null } {
  switch (steerStandingOf(note, liveBuild)) {
    case "read": return { words: "Read by the agent at", readAt: note.ackedAt ?? note.deliveredAt! };
    case "waiting": return { words: "Waiting for the agent to read it", readAt: null };
    case "not-picked-up": return { words: "Not picked up", readAt: null };
    case "next-attempt": return { words: "Will reach the next attempt", readAt: null };
    case "ended": return { words: "The task ended before the agent read it", readAt: null };
    case "unverified": return { words: "Saved before notes required a sign-in; never sent", readAt: null };
  }
}

export function steerStandingWords(note: SteerNote, liveBuild: boolean, time: (iso: string) => string): string {
  const { words, readAt } = steerStandingParts(note, liveBuild);
  return readAt === null ? words : `${words} ${time(readAt)}`;
}

/** Where a note filed now goes, said before or right after filing it. */
export function steerDestinationWords(liveBuild: boolean, liveInput = false): string {
  // A Claude build with live input takes it in seconds (steer-live.ts); any other running build reads its folder.
  return liveBuild && liveInput
    ? "The running agent gets it now."
    : liveBuild
      ? "The running agent reads it when it next checks for notes."
      : "The next attempt reads it before starting.";
}

/** A paused live build's one sentence: until when it can wait before it ends, and how long that is (live-input.ts
 * idleLimit), or only that it is paused when it has no idle limit. `time` renders the moment its surface's way. */
export function pausedWords(pause: { until: string | null; limitMs: number | null }, time: (iso: string) => string): string {
  if (pause.until === null || pause.limitMs === null) return "Paused.";
  return `Paused. It can wait until ${time(pause.until)} (${Math.max(1, Math.round(pause.limitMs / 60_000))} min) before it ends.`;
}
