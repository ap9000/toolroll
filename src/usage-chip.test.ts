/** The usage chip (docs/plans/agents-cockpit.md §3, R16): the most-used subscription window the providers reported,
 * its reset, stale by the reading's age, "resets: unknown" with no known reset, and a window that turned over reads 0%. */
import { expect, test } from "vitest";
import { usageChipOf } from "./limits-ui.js";

const now = new Date("2026-10-19T12:00:00.000Z");
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();
const window = (over: Partial<Parameters<typeof usageChipOf>[0][number]>) => ({ provider: "claude", window: "five_hour", usedPercent: 40, windowMinutes: 300,
  resetsAt: at(180), reached: false, plan: null, observedAt: at(-5), ...over });

test("the most-used window leads, with its reset", () => {
  expect(usageChipOf([window({ usedPercent: 40 }), window({ provider: "codex", window: "seven_day", usedPercent: 82, windowMinutes: 10_080, resetsAt: at(180) })], now))
    .toMatchObject({ text: "Codex Weekly · 82% · resets 3h", tone: "warning", stale: false, href: "/work" });
  expect(usageChipOf([], now)).toBeNull();
});

test("an old reading stays visibly stale; an unknown reset says so; a turned-over window starts again", () => {
  expect(usageChipOf([window({ observedAt: at(-120) })], now)).toMatchObject({ text: "Claude 5-hour · 40% · resets 3h · as of 2h ago", stale: true });
  expect(usageChipOf([window({ resetsAt: null })], now)!.text).toBe("Claude 5-hour · 40% · resets: unknown");
  // A reset that passed since the reading: what was read, marked stale, never an inferred 0%.
  expect(usageChipOf([window({ usedPercent: 82, resetsAt: at(-1), observedAt: at(-10) })], now)).toMatchObject({ text: "Claude 5-hour · 82% · window reset · as of 10m ago", tone: "neutral", stale: true });
  // A current window outranks an expired one, however high the old reading.
  expect(usageChipOf([window({ usedPercent: 95, resetsAt: at(-1) }), window({ provider: "codex", usedPercent: 30 })], now)!.text).toBe("Codex 5-hour · 30% · resets 3h");
  // No known length: no reset to name, even with a timestamp.
  expect(usageChipOf([window({ window: "custom", windowMinutes: null })], now)!.text).toBe("Claude custom · 40% · resets: unknown");
  expect(usageChipOf([window({ usedPercent: 100, reached: true })], now)!.tone).toBe("danger");
});
