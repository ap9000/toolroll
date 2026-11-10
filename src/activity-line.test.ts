/** What a running agent did last, in one line (activity-line.ts): the words, the age, and the five-minute quiet. */
import { describe, expect, test } from "vitest";
import { activityLine, agoWords, QUIET_AFTER_MS } from "./activity-line.js";

const AT = "2026-10-07T12:00:00.000Z";
const after = (ms: number) => Date.parse(AT) + ms;

describe("the last-activity line", () => {
  test("at five minutes of silence it says when it last heard, in neutral words (the needs-you mark is for what needs you)", () => {
    const ran = { what: "Edited files", at: AT, worker: "online" as const };
    expect(activityLine(ran, after(QUIET_AFTER_MS - 1_000)).stale).toBe(false);
    expect(activityLine(ran, after(QUIET_AFTER_MS))).toEqual({ text: "Last update 5 min ago", quiet: false, stale: true });
    expect(activityLine(ran, after(6 * 60_000 + 30_000))).toEqual({ text: "Last update 6 min ago", quiet: false, stale: true });
  });

  test("an offline worker says so, not that the agent is quiet", () => {
    const gone = { what: "Ran a command", at: AT, worker: "offline" as const };
    expect(activityLine(gone, after(40_000))).toEqual({ text: "Worker offline · last word 40 s ago", quiet: true, stale: false });
    expect(activityLine(gone, after(7 * 60_000))).toEqual({ text: "Worker offline · last word 7 min ago", quiet: true, stale: false });
  });

  test("ages read plainly; a clock behind the record never says the future", () => {
    expect(agoWords(-5_000)).toBe("just now");
    expect(agoWords(59_000)).toBe("59 s ago");
    expect(agoWords(2 * 3_600_000)).toBe("2 h ago");
    expect(activityLine({ what: "Read the code", at: AT, worker: "online" }, after(-60_000)).text).toBe("Read the code · just now");
  });
});
