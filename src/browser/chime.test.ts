// @vitest-environment happy-dom
/** The chime (docs/plans/agents-cockpit.md §3): off until this browser turns it on; the first snapshot only learns;
 * something newly needing this person chimes once across tabs; a reconnect replays nothing; a visible tab showing it
 * means no chime. */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { NO_COUNTS } from "../agent-state-words.js";
import type { BrowserProjectState } from "../browser-workspace.js";
import { CHIME_SETTLE_MS, createChime, setChime } from "./chime.js";

const snapshot = (...asks: string[]): BrowserProjectState[] => [{ path: "/r", name: "r", href: "/work", state: asks.length ? "needs-you" : "idle", counts: { ...NO_COUNTS, "needs-you": asks.length },
  tasks: asks.map(id => ({ id, title: id, href: `/t/${id}`, state: "needs-you" as const, line: "Review the plan." })), more: 0 }];
const hidden = () => ({ visible: false, path: "/chat" });

beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
afterEach(() => { vi.useRealTimers(); });

test("off until turned on; the first snapshot only learns; a new ask chimes once", () => {
  let plays = 0;
  const tab = createChime(() => { plays += 1; }, hidden);
  tab.see(snapshot("a"));
  tab.see(snapshot("a", "b"));
  vi.advanceTimersByTime(CHIME_SETTLE_MS);
  expect(plays).toBe(0);
  setChime(true);
  tab.see(snapshot("a", "b", "c"));
  vi.advanceTimersByTime(CHIME_SETTLE_MS);
  expect(plays).toBe(1);
  tab.see(snapshot("a", "b", "c"));
  vi.advanceTimersByTime(CHIME_SETTLE_MS);
  expect(plays).toBe(1);
  tab.close();
});

test("two tabs chime once between them, and a reconnecting page replays nothing", () => {
  setChime(true);
  let plays = 0;
  const one = createChime(() => { plays += 1; }, hidden), two = createChime(() => { plays += 1; }, hidden);
  one.see(snapshot()); two.see(snapshot());
  one.see(snapshot("x")); two.see(snapshot("x"));
  vi.advanceTimersByTime(CHIME_SETTLE_MS);
  expect(plays).toBe(1);
  // A fresh page (a reload, a reconnect) learns what is waiting, and an ask it already heard never chimes again.
  const again = createChime(() => { plays += 1; }, hidden);
  again.see(snapshot());
  again.see(snapshot("x"));
  vi.advanceTimersByTime(CHIME_SETTLE_MS);
  expect(plays).toBe(1);
  for (const tab of [one, two, again]) tab.close();
});

test("a visible tab already showing the ask means no chime", () => {
  setChime(true);
  let plays = 0;
  const showing = createChime(() => { plays += 1; }, () => ({ visible: true, path: "/t/y" }));
  showing.see(snapshot());
  showing.see(snapshot("y"));
  vi.advanceTimersByTime(CHIME_SETTLE_MS);
  expect(plays).toBe(0);
  showing.close();
});
