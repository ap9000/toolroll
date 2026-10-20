// @vitest-environment happy-dom
/** The chime (docs/plans/agents-cockpit.md §3): off until this browser turns it on; the first snapshot only learns; a
 * new obligation or a new version of one chimes once across tabs (one Web Lock decides); a reconnect replays nothing;
 * a visible tab showing its task or its agent means no chime; only opaque keys are kept. */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { NO_COUNTS } from "../agent-state-words.js";
import type { BrowserAsk, BrowserProjectState } from "../browser-workspace.js";
import { CHIME_MEMORY_MS, CHIME_SETTLE_MS, createChime, setChime, type Showing } from "./chime.js";

const ask = (key: string, task: string | null = null, run: number | null = null, at = new Date().toISOString()): BrowserAsk => ({ key: `k${key.padEnd(10, "0")}`, task, run, at });
const snapshot = (...asks: BrowserAsk[]): BrowserProjectState[] => [{ path: "/r", name: "r", href: "/work", state: asks.length ? "needs-you" : "idle",
  counts: { ...NO_COUNTS, "needs-you": asks.length }, tasks: [], more: 0, asks }];
const away = (): Showing => ({ visible: false, task: null, run: null });
/** A lock manager that serializes, the way the browser's does across tabs, with each holder yielding inside. */
function serialLocks() {
  let tail = Promise.resolve();
  return { request: (_name: string, act: () => unknown) => { const next = tail.then(async () => { await Promise.resolve(); act(); }); tail = next; return next; } };
}
const settle = async () => { vi.advanceTimersByTime(CHIME_SETTLE_MS); for (let i = 0; i < 10; i++) await Promise.resolve(); };

beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); Object.defineProperty(navigator, "locks", { configurable: true, value: serialLocks() }); });
afterEach(() => { vi.useRealTimers(); });

test("off until turned on; the first snapshot only learns; a new ask, or a new version of one, chimes once", async () => {
  let plays = 0;
  const tab = createChime(() => { plays += 1; }, away);
  tab.see(snapshot(ask("a", "t-1")));
  tab.see(snapshot(ask("a", "t-1"), ask("b", "t-2")));
  await settle();
  expect(plays).toBe(0);
  setChime(true);
  tab.see(snapshot(ask("a", "t-1"), ask("b", "t-2"), ask("c", "t-3")));
  await settle();
  expect(plays).toBe(1);
  tab.see(snapshot(ask("a", "t-1"), ask("b", "t-2"), ask("c", "t-3")));
  await settle();
  expect(plays).toBe(1);
  // The same task needs this person for something new (a second question): a new key, a new chime.
  tab.see(snapshot(ask("a2", "t-1"), ask("b", "t-2"), ask("c", "t-3")));
  await settle();
  expect(plays).toBe(2);
  tab.close();
});

test("two tabs that see the same new ask at once chime once between them; a reconnecting page replays nothing", async () => {
  setChime(true);
  let plays = 0;
  const one = createChime(() => { plays += 1; }, away), two = createChime(() => { plays += 1; }, away);
  one.see(snapshot()); two.see(snapshot());
  one.see(snapshot(ask("x"))); two.see(snapshot(ask("x")));
  await settle();
  expect(plays).toBe(1);
  const again = createChime(() => { plays += 1; }, away);
  again.see(snapshot());
  again.see(snapshot(ask("x")));
  await settle();
  expect(plays).toBe(1);
  for (const tab of [one, two, again]) tab.close();
});

test("a visible tab showing the ask's task or its agent means no chime", async () => {
  setChime(true);
  let plays = 0;
  const task = createChime(() => { plays += 1; }, () => ({ visible: true, task: "t-9", run: null }));
  task.see(snapshot());
  task.see(snapshot(ask("y", "t-9")));
  const agent = createChime(() => { plays += 1; }, () => ({ visible: true, task: null, run: 42 }));
  agent.see(snapshot());
  agent.see(snapshot(ask("z", "t-8", 42)));
  await settle();
  expect(plays).toBe(0);
  task.close(); agent.close();
});

test("only opaque keys are kept, never words", async () => {
  const tab = createChime(() => {}, away);
  tab.see(snapshot());
  tab.see(snapshot(ask("q", "t-1")));
  await settle();
  const kept = Object.keys(localStorage).map(key => `${key}=${localStorage.getItem(key)}`).join("\n");
  expect(kept).toContain("kq000000000");
  expect(kept).not.toMatch(/t-1|question|\?/);
  tab.close();
});

test("an older format that kept words is removed; a subject unchanged since before the memory reaches back never chimes", async () => {
  localStorage.setItem("toolroll.chime.heard", JSON.stringify(["t-1\u0000Keep the old OAuth button?"]));
  setChime(true);
  let plays = 0;
  const tab = createChime(() => { plays += 1; }, away);
  tab.see(snapshot());
  expect(localStorage.getItem("toolroll.chime.heard")).toBeNull();
  // A key heard long ago has been forgotten, but what it was about has not changed since: still no news.
  const long = Date.now() - CHIME_MEMORY_MS - 86_400_000;
  localStorage.setItem("toolroll.chime.v2", JSON.stringify({ since: long + 1000, keys: {} }));
  tab.see(snapshot(ask("old", "t-5", null, new Date(long).toISOString())));
  await settle();
  expect(plays).toBe(0);
  // Something that changed since does chime.
  tab.see(snapshot(ask("old", "t-5", null, new Date(long).toISOString()), ask("new", "t-6")));
  await settle();
  expect(plays).toBe(1);
  tab.close();
});
