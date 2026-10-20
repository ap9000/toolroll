/**
 * The chime (docs/plans/agents-cockpit.md §3): an optional sound when something new needs this person and no visible
 * tab is already showing it. Off by default and set per browser. Its subjects are the summary's asks — one opaque key
 * per obligation and version, scoped to the reader by the server, never words — so a second question on the same task
 * is new, and nothing private is kept (an older format that kept words is removed). One chime per key across every
 * open tab: the check and the remembering happen under one Web Lock. A key once heard is remembered for 30 days, and an
 * ask unchanged since before that memory reaches back is never news, so a reconnect, another tab or a returning
 * subject replays nothing. The first snapshot a page sees only learns what is already waiting.
 */
import type { BrowserAsk, BrowserProjectState } from "../browser-workspace.js";

const SETTING = "toolroll.chime";
/** What this browser has heard: opaque keys with when, and how far back that memory reaches. */
const MEMORY = "toolroll.chime.v2";
/** An earlier format kept words: it is removed, never read. */
const LEGACY = "toolroll.chime.heard";
const CHANNEL = "toolroll-chime";
/** How long a tab waits to hear that a visible tab is showing the subject before claiming it. */
export const CHIME_SETTLE_MS = 200;
/** How long a heard key is kept. An ask unchanged since before the memory reaches back is never news. */
export const CHIME_MEMORY_MS = 30 * 86_400_000;

/** What this tab shows now: whether it is visible, and the task page or agent it has open. */
export type Showing = { visible: boolean; task: string | null; run: number | null };

export function asksOf(states: readonly BrowserProjectState[]): BrowserAsk[] {
  return states.flatMap(one => one.asks);
}

const storage = (): Storage | null => { try { return window.localStorage; } catch { return null; } };
export function chimeOn(): boolean { try { return storage()?.getItem(SETTING) === "1"; } catch { return false; } }
export function setChime(on: boolean): void { try { if (on) storage()?.setItem(SETTING, "1"); else storage()?.removeItem(SETTING); } catch { /* this browser keeps no settings */ } }
type Memory = { since: number; keys: Record<string, number> };
const OPAQUE = /^[A-Za-z0-9_-]{8,64}$/;
function memory(): Memory {
  try { storage()?.removeItem(LEGACY); } catch { /* nothing to remove */ }
  try {
    const raw = JSON.parse(storage()?.getItem(MEMORY) ?? "null") as Partial<Memory> | null;
    const keys: Record<string, number> = {};
    for (const [key, at] of Object.entries(raw?.keys ?? {})) if (OPAQUE.test(key) && typeof at === "number") keys[key] = at;
    return { since: typeof raw?.since === "number" ? raw.since : 0, keys };
  } catch { return { since: 0, keys: {} }; }
}
function remember(keys: readonly string[], now: number): void {
  const kept = memory();
  // Keys older than the memory's reach are dropped, and the reach moves up with them.
  const reach = now - CHIME_MEMORY_MS;
  for (const [key, at] of Object.entries(kept.keys)) if (at < reach) { delete kept.keys[key]; kept.since = Math.max(kept.since, at); }
  for (const key of keys) if (OPAQUE.test(key)) kept.keys[key] = now;
  try { storage()?.setItem(MEMORY, JSON.stringify(kept)); } catch { /* nothing to remember with */ }
}
/** Heard before: kept as heard, or unchanged since before the memory reaches back. */
function heardBefore(ask: BrowserAsk, kept: Memory): boolean {
  return Object.hasOwn(kept.keys, ask.key) || (kept.since > 0 && Date.parse(ask.at) <= kept.since);
}

/** A tone, made here (no file to fetch): two short notes. */
export function playChime(): void {
  try {
    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Context === undefined) return;
    const context = new Context();
    [880, 1175].forEach((pitch, index) => {
      const tone = context.createOscillator(), level = context.createGain();
      const start = context.currentTime + index * 0.12;
      tone.frequency.value = pitch;
      level.gain.setValueAtTime(0.0001, start);
      level.gain.exponentialRampToValueAtTime(0.12, start + 0.02);
      level.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
      tone.connect(level).connect(context.destination);
      tone.start(start); tone.stop(start + 0.25);
    });
    window.setTimeout(() => { void context.close(); }, 1_000);
  } catch { /* no sound here */ }
}

/** Run `act` while holding this origin's chime lock (atomic across tabs); without Web Locks, run it as is. */
async function exclusively(act: () => void): Promise<void> {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (locks === undefined) { act(); return; }
  await locks.request(CHANNEL, () => { act(); });
}

/**
 * One page's chime: feed it every snapshot. The first one only learns; after it, a key not heard before chimes once
 * across tabs, unless a visible tab is showing what it is about.
 */
export function createChime(play: () => void = playChime, showing: () => Showing = () => ({ visible: document.visibilityState === "visible", task: null, run: null })) {
  let known: Set<string> | null = null;
  const shown = new Set<string>();
  let channel: BroadcastChannel | null = null;
  try { channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL); } catch { channel = null; }
  if (channel !== null) channel.onmessage = event => {
    const key = (event.data as { showing?: unknown } | null)?.showing;
    if (typeof key === "string") shown.add(key);
  };
  return {
    see(states: readonly BrowserProjectState[]): void {
      const asks = asksOf(states);
      const before = known;
      known = new Set(asks.map(one => one.key));
      // A visible tab showing what an ask is about says so: that one is seen, not chimed.
      const here = showing();
      const onScreen = asks.filter(one => here.visible && ((one.task !== null && one.task === here.task) || (one.run !== null && one.run === here.run))).map(one => one.key);
      for (const key of onScreen) { shown.add(key); channel?.postMessage({ showing: key }); }
      if (before === null) { remember(asks.map(one => one.key), Date.now()); return; }
      const fresh = asks.filter(one => !before.has(one.key));
      if (fresh.length === 0) return;
      window.setTimeout(() => {
        void exclusively(() => {
          // Under the lock: what any tab has heard is final, so exactly one tab claims each key.
          const kept = memory();
          const mine = fresh.filter(one => !heardBefore(one, kept));
          remember(fresh.map(one => one.key), Date.now());
          if (chimeOn() && mine.some(one => !shown.has(one.key))) play();
        });
      }, CHIME_SETTLE_MS);
    },
    close(): void { channel?.close(); },
  };
}
