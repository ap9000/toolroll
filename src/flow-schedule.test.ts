/**
 * Schedules (flow-owned since v115): the schedule algebra a schedule trigger fires on, and a standing order's digest —
 * the same bytes a routine's was, so an approval moved over from a routine still verifies.
 */
import { describe, expect, test } from "vitest";
import { describeSchedule, firstFireAt, instanceId, nextFireAt, parseSchedule, standingApproval, standingDigestOf, type StandingOrder } from "./flow-schedule.js";
import { parseAcceptanceCriteria, type ExecutionProfile } from "./scope.js";
import type { PhaseRoute } from "./phase-routing.js";

const T0 = new Date("2026-08-13T22:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const later = (ms: number) => new Date(T0.getTime() + ms);

describe("the schedule algebra", () => {
  test("parses the readable shapes and refuses everything else", () => {
    expect(parseSchedule("every:60")).toEqual({ kind: "every", minutes: 60 });
    expect(parseSchedule("daily:03:30")).toEqual({ kind: "daily", hhmm: "03:30" });
    expect(parseSchedule("weekdays:09:00@Europe/London")).toEqual({ kind: "weekdays", hhmm: "09:00", timezone: "Europe/London" });
    expect(parseSchedule("weekly:1:09:00")).toEqual({ kind: "weekly", day: 1, hhmm: "09:00" });
    expect(parseSchedule("every:4")).toBeNull(); // under the 5-minute floor
    expect(parseSchedule("every:999999")).toBeNull();
    expect(parseSchedule("daily:24:00")).toBeNull();
    expect(parseSchedule("daily:9:30")).toBeNull(); // zero-padded or nothing
    expect(parseSchedule("daily:09:30@Not/AZone")).toBeNull();
    expect(parseSchedule("cron:* * * * *")).toBeNull();
  });

  test("says what it means in words", () => {
    expect(describeSchedule({ kind: "every", minutes: 90 })).toBe("every 90 minutes");
    expect(describeSchedule({ kind: "every", minutes: 120 })).toBe("every 2 hour(s)");
    expect(describeSchedule({ kind: "every", minutes: 2880 })).toBe("every 2 day(s)");
    expect(describeSchedule({ kind: "daily", hhmm: "03:30" })).toBe("daily at 03:30 UTC");
  });

  test("advances aligned: strictly after now, anchored to the fired slot", () => {
    const every = { kind: "every" as const, minutes: 60 };
    const anchor = T0.toISOString();
    expect(nextFireAt(every, anchor, T0)).toBe(later(HOUR).toISOString());
    // A pass 10 minutes late does not tilt the grid.
    expect(nextFireAt(every, anchor, later(10 * MINUTE))).toBe(later(HOUR).toISOString());
    // Down for five slots: one overdue firing, then the grid strictly after now — no backfill burst.
    expect(nextFireAt(every, anchor, later(5 * HOUR + 10 * MINUTE))).toBe(later(6 * HOUR).toISOString());
    expect(nextFireAt(every, anchor, later(2 * HOUR))).toBe(later(3 * HOUR).toISOString());
  });

  test("calendar schedules align to the clock, not to when the pass happened to run", () => {
    const daily = { kind: "daily" as const, hhmm: "03:30" };
    expect(nextFireAt(daily, T0.toISOString(), T0)).toBe("2026-08-14T03:30:00.000Z");
    expect(firstFireAt(daily, new Date("2026-08-13T02:00:00.000Z"))).toBe("2026-08-13T03:30:00.000Z");
    expect(firstFireAt(daily, new Date("2026-08-13T03:30:00.000Z"))).toBe("2026-08-14T03:30:00.000Z");
    // Monday to Friday: Friday's 09:00 is followed by Monday's.
    expect(nextFireAt(parseSchedule("weekdays:09:00")!, "2026-09-25T09:00:00.000Z", new Date("2026-09-25T09:00:00.000Z"))).toBe("2026-09-28T09:00:00.000Z");
  });

  test("a firing's task id carries the slot it satisfied", () => {
    expect(instanceId("deps", "2026-08-13T22:00:00.000Z")).toBe("deps-20260813-2200");
  });
});

const ORDER: StandingOrder = {
  stem: "deps", goal: "Refresh the dependency lockfile and note anything major", outOfScope: "No version bumps beyond patch", touches: ["package.json"], requirements: [],
  acceptance: [{ id: "c1", statement: "The refreshed lockfile still installs cleanly.", evidence: ["check"] }],
  budgetPerRunMicrousd: null, costCeilingUsd: 10, singleFlight: true, filedBy: "alex", routine: null, approval: null,
};
const PROFILE = { provider: "claude", model: "sonnet", permissionArgv: "acceptEdits", maxTurns: 40, repairMaxTurns: 4, timeoutSeconds: 1800, repairTimeoutSeconds: 300, repairModel: "inherit" } as ExecutionProfile;
const ROUTE = { version: 1, risk: "routine", qualityMode: "default", publication: "none", evidence: ["check"], posture: "routine", demands: [], overrides: [],
  legs: (["plan", "build", "repair", "review"] as const).map(phase => ({ phase, provider: "claude", model: "sonnet", tier: "routine", chosen: "recommended", recommended: { provider: "claude", model: "sonnet" }, reasons: [], problem: null })) } as unknown as PhaseRoute;

describe("a standing order's digest", () => {
  const acceptance = parseAcceptanceCriteria(ORDER.acceptance).criteria;
  const digest = (order: StandingOrder, repo = "/work/repo", schedule = "every:60") => standingDigestOf(repo, schedule, order, acceptance, PROFILE, ROUTE);

  test("binds every term, the schedule and the project — not just the scope", () => {
    const base = digest(ORDER);
    expect(digest({ ...ORDER, touches: ["package.json"] })).toBe(base);
    for (const changed of [
      digest({ ...ORDER, goal: "Something else" }), digest({ ...ORDER, outOfScope: null }), digest({ ...ORDER, touches: ["src/"] }),
      digest({ ...ORDER, requirements: ["tool:node"] }), digest({ ...ORDER, costCeilingUsd: 20 }), digest({ ...ORDER, budgetPerRunMicrousd: 1_000_000 }),
      digest(ORDER, "/work/other"), digest(ORDER, "/work/repo", "every:30"),
    ]) expect(changed).not.toBe(base);
  });

  test("no approval is not live and names no problem; an approval for other terms is refused in words", () => {
    expect(standingApproval(ORDER, "/work/repo", "every:60")).toMatchObject({ live: false, problem: null });
    const approval = { digest: "0".repeat(32), by: "sam", at: T0.toISOString(), profileJson: JSON.stringify({ digestVersion: 2, profile: PROFILE }), routeJson: "{}" };
    expect(standingApproval({ ...ORDER, approval }, "/work/repo", "every:60")).toMatchObject({ live: false, problem: "the agents its approval froze can't be read back" });
  });
});

describe("where a standing order can come from", () => {
  test("no trigger a person, a flow file or the lead gives can carry one (only the v115 migration writes an approval)", async () => {
    const { readTriggerSettings } = await import("./flow-triggers.js");
    const { flowFileTriggerSchema, leadTriggerSchema } = await import("./contracts/flow.js");
    const given = { kind: "schedule", schedule: "every:60", title: "Deps", order: { ...ORDER, approval: { digest: "0".repeat(32), by: "sam", at: T0.toISOString(), profileJson: "{}", routeJson: "{}" } } };
    const read = readTriggerSettings(given);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.issues.map(one => one.line).join("; ")).toMatch(/order/);
    expect(flowFileTriggerSchema.safeParse(given).success).toBe(false);
    expect(leadTriggerSchema.safeParse(given).success).toBe(false);
  });
});
