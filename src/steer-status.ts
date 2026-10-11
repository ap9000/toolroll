/**
 * Where a steering note stands, in the one set of words the task page, the
 * CLI and the lead all use (v120). A note is read only when the agent proves
 * it: the stream's receipt of a brief that quoted it, or the agent moving it
 * to handled/ in a running build's steering folder. Everything else is
 * either waiting for the agent that is running now, or for the next attempt.
 */
import type { SteerNote } from "./store.js";

export type SteerStanding = "read" | "waiting" | "next-attempt" | "ended" | "unverified";

/** `liveBuild`: the task has a build whose agent is running and reads its steering folder (Store.steeringLiveBuild). */
export function steerStandingOf(note: SteerNote, liveBuild: boolean): SteerStanding {
  if (note.authorshipState !== "verified") return "unverified";
  if (note.supersededAt !== null) return "ended";
  if (note.deliveredAt !== null) return "read";
  return liveBuild ? "waiting" : "next-attempt";
}

/** The words, and the moment the agent read it when it has: each surface renders that time its own way. */
export function steerStandingParts(note: SteerNote, liveBuild: boolean): { words: string; readAt: string | null } {
  switch (steerStandingOf(note, liveBuild)) {
    case "read": return { words: "Read by the agent at", readAt: note.ackedAt ?? note.deliveredAt! };
    case "waiting": return { words: "Waiting for the agent to read it", readAt: null };
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
export function steerDestinationWords(liveBuild: boolean): string {
  return liveBuild
    ? "The running agent reads it when it next checks for notes."
    : "The next attempt reads it before starting.";
}
