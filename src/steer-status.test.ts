import { describe, expect, test } from "vitest";
import { steerStandingWords } from "./steer-status.js";
import type { SteerNote } from "./store.js";

const note = (over: Partial<SteerNote> = {}): SteerNote => ({
  id: 1, taskRef: 1, author: "alex", note: "prefer the smaller diff", createdAt: "2026-10-11T12:00:00.000Z",
  attachedRun: null, attachedAt: null, deliveredAt: null, supersededAt: null, authorshipState: "verified", supersededReason: null,
  mailedRun: null, mailedAt: null, ackedAt: null, liveUuid: null, liveSends: 0, liveSentAt: null, liveMissedAt: null, ...over,
});
const words = (one: SteerNote, live: boolean) => steerStandingWords(one, live, iso => iso.slice(11, 16));

describe("one set of words for where a steering note stands (v120)", () => {
  test("read, waiting for the running agent, or bound for the next attempt", () => {
    expect(words(note(), true)).toBe("Waiting for the agent to read it");
    expect(words(note({ mailedRun: 7, mailedAt: "2026-10-11T12:01:00.000Z" }), true)).toBe("Waiting for the agent to read it");
    expect(words(note(), false)).toBe("Will reach the next attempt");
    // Mailed to a build that ended before its agent read it: the next attempt's brief carries it.
    expect(words(note({ mailedRun: 7, mailedAt: "2026-10-11T12:01:00.000Z" }), false)).toBe("Will reach the next attempt");
    // Read in the folder, or quoted in a brief whose receipt the stream proved.
    expect(words(note({ attachedRun: 7, attachedAt: "x", deliveredAt: "2026-10-11T12:04:00.000Z", ackedAt: "2026-10-11T12:04:00.000Z" }), true)).toBe("Read by the agent at 12:04");
    expect(words(note({ attachedRun: 7, attachedAt: "x", deliveredAt: "2026-10-11T12:02:00.000Z" }), false)).toBe("Read by the agent at 12:02");
  });

  test("a note the running build was sent every time it was owed and never moved reads Not picked up, until it ends", () => {
    const missed = note({ mailedRun: 7, mailedAt: "2026-10-11T12:01:00.000Z", liveSends: 4, liveMissedAt: "2026-10-11T12:07:00.000Z" });
    expect(words(missed, true)).toBe("Not picked up");
    expect(words(missed, false)).toBe("Will reach the next attempt");
    expect(words({ ...missed, deliveredAt: "2026-10-11T12:09:00.000Z", ackedAt: "2026-10-11T12:09:00.000Z" }, true)).toBe("Read by the agent at 12:09");
  });

  test("a note the task outlived, or one saved before notes needed a sign-in, says so", () => {
    expect(words(note({ supersededAt: "2026-10-11T13:00:00.000Z" }), false)).toBe("The task ended before the agent read it");
    expect(words(note({ authorshipState: "unverified-legacy" }), true)).toBe("Saved before notes required a sign-in; never sent");
  });

});
