/**
 * The chime (docs/plans/agents-cockpit.md §3): an optional sound when something new needs this person and no visible
 * tab is already showing it. Off by default and set per browser. Its subjects are the summary's asks — one opaque key
 * per obligation and version, scoped to the reader by the server, never words — so a second question on the same task
 * is new, and nothing private is kept. One chime per key across every open tab: the check and the remembering happen
 * under one Web Lock, and a key once heard is remembered, so a reconnect or another tab replays nothing. The first
 * snapshot a page sees only learns what is already waiting.
 */
import type { BrowserAsk, BrowserProjectState } from "../browser-workspace.js";

const SETTING = "toolroll.chime";
const HEARD = "toolroll.chime.heard";
const CHANNEL = "toolroll-chime";
/** How long a tab waits to hear that a visible tab is showing the subject before claiming it. */
export const CHIME_SETTLE_MS = 200;
/** Remembered keys, newest kept. */
const HEARD_KEEP = 2_000;

/** What this tab shows now: whether it is visible, and the task page or agent it has open. */
export type Showing = { visible: boolean; task: string | null; run: number | null };

export function asksOf(states: readonly BrowserProjectState[]): BrowserAsk[] {
  return states.flatMap(one => one.asks);
}

const storage = (): Storage | null => { try { return window.localStorage; } catch { return null; } };
export function chimeOn(): boolean { try { return storage()?.getItem(SETTING) === "1"; } catch { return false; } }
export function setChime(on: boolean): void { try { if (on) storage()?.setItem(SETTING, "1"); else storage()?.removeItem(SETTING); } catch { /* this browser keeps no settings */ } }
function heard(): Set<string> { try { const raw = JSON.parse(storage()?.getItem(HEARD) ?? "[]"); return new Set(Array.isArray(raw) ? raw.filter((one): one is string => typeof one === "string") : []); } catch { return new Set(); } }
function remember(keys: readonly string[]): void {
  try { storage()?.setItem(HEARD, JSON.stringify([...new Set([...heard(), ...keys])].slice(-HEARD_KEEP))); } catch { /* nothing to remember with */ }
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
      if (before === null) { remember(asks.map(one => one.key)); return; }
      const fresh = asks.map(one => one.key).filter(key => !before.has(key));
      if (fresh.length === 0) return;
      window.setTimeout(() => {
        void exclusively(() => {
          // Under the lock: what any tab has heard is final, so exactly one tab claims each key.
          const old = heard();
          const mine = fresh.filter(key => !old.has(key));
          remember(fresh);
          if (chimeOn() && mine.some(key => !shown.has(key))) play();
        });
      }, CHIME_SETTLE_MS);
    },
    close(): void { channel?.close(); },
  };
}
