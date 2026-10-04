/**
 * The raised limits, the one shorten turn, keeping text whole and linked instead of cutting it, and chat platforms'
 * own limits met by splitting across messages.
 */
import { expect, test } from "vitest";
import { LIMITS, NOTE_BYTE_CAP, validateNote } from "./decision.js";
import { LEAD_REPLY_LIMITS, leadContext } from "./lead-context.js";
import { openStore } from "./store.js";
import { REPORT_LIMITS, parseReport } from "./scout-report.js";
import { shapeReplyParts } from "./reply-shape.js";
import { PART_CAP, splitParts } from "./telegram-mate.js";
import { limitRule, overruns, passOn, PLATFORM_LIMITS, shortenAsk, TEXT_LIMITS, writeWithin } from "./text-limits.js";

test("the raised limits: notes 4000, flow instructions 8000, report summary 2500 bytes, a step's output 12000", () => {
  expect(TEXT_LIMITS).toMatchObject({ goal: 8_000, goalBytes: 32_000, note: 4_000, flowInstructions: 8_000, reportSummary: 2_500, stageOutput: 12_000 });
  expect(LIMITS.note).toBe(4_000);
  expect(NOTE_BYTE_CAP).toBe(16_000);
  expect(validateNote("n".repeat(4_000))).toEqual({ ok: true, note: "n".repeat(4_000) });
  expect(validateNote("n".repeat(4_001))).toEqual({ ok: false, problem: "a note is at most 4000 characters" });
  expect(REPORT_LIMITS.summary).toBe(2_500);
  expect(REPORT_LIMITS.followUpGoal).toBe(8_000);
});

test("a stored report is read without its length caps; a new one is still held to them", () => {
  const report = JSON.stringify({ title: "Found it", summary: "s".repeat(REPORT_LIMITS.summary + 1), report: "## Findings" });
  expect(parseReport(report)).toMatchObject({ ok: false, problems: [{ reason: "summary-too-long" }] });
  expect(parseReport(report, { stored: true })).toMatchObject({ ok: true, report: { summary: "s".repeat(REPORT_LIMITS.summary + 1) } });
  // Every other check still holds when reading.
  expect(parseReport(JSON.stringify({ title: "two\nlines", summary: "s", report: "r" }), { stored: true }).ok).toBe(false);
});

test("a model is told the exact limit before it writes", () => {
  expect(limitRule("The draft", 12_000)).toBe("The draft: at most 12,000 characters. Put the most important part first. Longer text is not cut: you will be asked to shorten it.");
  expect(limitRule("summary", 2_500, "bytes")).toContain("at most 2,500 bytes");
});

test("an answer over a limit is asked once to shorten, naming each field, its length and its limit", () => {
  const over = overruns({ text: "t".repeat(12_001), note: "fine" }, { text: 12_000, note: 4_000 });
  expect(over).toEqual([{ field: "text", limit: 12_000, length: 12_001 }]);
  expect(shortenAsk(over)).toBe([
    "Your answer is over a limit:",
    "- text is 12,001 characters; the limit is 12,000.",
    "Answer again with the same decision and meaning, each field within its limit. Shorten by dropping repetition and detail, not facts that matter.",
  ].join("\n"));
  expect(overruns({ summary: "é".repeat(1_300) }, { summary: 2_500 }, "bytes")).toEqual([{ field: "summary", limit: 2_500, length: 2_600, unit: "bytes" }]);
});

test("writeWithin: within the limit is one turn; over is one shorten turn; still over is kept whole, never a third turn", async () => {
  const ask = (answers: string[]) => {
    const asked: (string | null)[] = [];
    return { asked, write: async (shorten: string | null) => { asked.push(shorten); return answers[asked.length - 1]!; } };
  };
  const check = (answer: string) => overruns({ draft: answer }, { draft: 10 });
  const fits = ask(["short"]);
  expect(await writeWithin(fits.write, check)).toEqual({ answer: "short", over: [], repaired: false });
  expect(fits.asked).toEqual([null]);
  const shortened = ask(["far too long a draft", "short now"]);
  expect(await writeWithin(shortened.write, check)).toEqual({ answer: "short now", over: [], repaired: true });
  expect(shortened.asked[1]).toContain("draft is 20 characters; the limit is 10.");
  const stubborn = ask(["far too long a draft", "still far too long", "never asked"]);
  const kept = await writeWithin(stubborn.write, check);
  expect(kept).toMatchObject({ answer: "still far too long", repaired: true, over: [{ field: "draft", length: 18 }] });
  expect(stubborn.asked).toHaveLength(2);
});

test("text passed on is whole within the limit; over it, kept whole where it was written and linked, never cut", () => {
  expect(passOn("n".repeat(4_001), 4_000, { label: "the card's discussion", href: "/flows/1?card=2" }, "a note holds").text).toBe("This is 4,001 characters, more than the 4,000 a note holds, so it is kept whole on the card's discussion: /flows/1?card=2.");
  expect(passOn("whole", 12_000, { label: "the card", href: "/flows/1?card=2" })).toEqual({ text: "whole", kept: false });
  const long = passOn("x".repeat(12_001), 12_000, { label: "the card's Draft step", href: "/flows/1?card=2" });
  expect(long).toEqual({ text: "This is 12,001 characters, more than the 12,000 a step passes on, so it is kept whole on the card's Draft step: /flows/1?card=2.", kept: true });
});

test("platform limits split across messages, never cut: Telegram 4096, Discord 2000, Slack 4000, Teams 6000", () => {
  expect(PLATFORM_LIMITS).toEqual({ telegram: 4_096, discord: 2_000, slack: 4_000, teams: 6_000 });
  expect(LEAD_REPLY_LIMITS).toMatchObject({ telegram: 4_096, discord: 2_000, slack: 4_000, teams: 6_000, console: null, terminal: null });
  // The lead is told each channel's limit in the words it reads before it writes.
  const store = openStore(":memory:");
  for (const channel of ["telegram", "slack", "discord", "teams"] as const) {
    expect((JSON.parse(leadContext(store, [], new Date("2026-10-04T09:00:00Z"), { channel })) as { channel: unknown }).channel).toMatchObject({ replyLimit: PLATFORM_LIMITS[channel], fit: expect.stringContaining(`within ${PLATFORM_LIMITS[channel].toLocaleString("en-US")} characters`) });
  }
  store.close();
  const reply = Array.from({ length: 300 }, (_, i) => `Line ${i}: the checkout keeps each line item's rounding, and the total matches the receipt.`).join("\n");
  // Telegram: its own splitter, under its message limit, every character kept in order.
  const telegram = splitParts(reply);
  expect(PART_CAP).toBeLessThanOrEqual(PLATFORM_LIMITS.telegram);
  expect(telegram.length).toBeGreaterThan(1);
  for (const part of telegram) expect(part.length).toBeLessThanOrEqual(PLATFORM_LIMITS.telegram);
  expect(telegram.join("")).toBe(reply);
  // Discord (parts of 1800) and Slack (2800): the shared reply shaper, each part under the platform's limit, nothing dropped.
  for (const [size, limit] of [[1_800, PLATFORM_LIMITS.discord], [2_800, PLATFORM_LIMITS.slack]] as const) {
    const parts = shapeReplyParts(reply, size);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(limit);
    expect(parts.join("").replace(/\s+/g, "")).toBe(reply.replace(/\s+/g, ""));
  }
});
