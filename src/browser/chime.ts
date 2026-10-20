/**
 * The chime (docs/plans/agents-cockpit.md §3): an optional sound when something new needs this person and no visible
 * tab is already showing it. Off by default and set per browser. One chime per subject and version across every open
 * tab (a BroadcastChannel), and never again for one already heard — the keys are remembered, so a reconnect's first
 * snapshot replays nothing. The first snapshot a page sees only learns what is already waiting.
 */
import type { BrowserProjectState } from "../browser-workspace.js";

const SETTING = "toolroll.chime";
const HEARD = "toolroll.chime.heard";
const CHANNEL = "toolroll-chime";
/** How long a tab waits to hear that another tab took (or is showing) the same subject before chiming itself. */
export const CHIME_SETTLE_MS = 200;
/** Remembered keys, newest kept. */
const HEARD_KEEP = 200;

/** A subject that needs this person, by identity and version: the task and what it needs now. */
export function chimeKeysOf(states: readonly BrowserProjectState[]): Map<string, string> {
  const keys = new Map<string, string>();
  for (const project of states) for (const task of project.tasks) if (task.state === "needs-you") keys.set(`${task.id}\u0000${task.line}`, task.href);
  return keys;
}

const storage = (): Storage | null => { try { return window.localStorage; } catch { return null; } };
export function chimeOn(): boolean { try { return storage()?.getItem(SETTING) === "1"; } catch { return false; } }
export function setChime(on: boolean): void { try { if (on) storage()?.setItem(SETTING, "1"); else storage()?.removeItem(SETTING); } catch { /* this browser keeps no settings */ } }
function heard(): string[] { try { const raw = JSON.parse(storage()?.getItem(HEARD) ?? "[]"); return Array.isArray(raw) ? raw.filter((one): one is string => typeof one === "string") : []; } catch { return []; } }
function remember(keys: readonly string[]): void {
  try { storage()?.setItem(HEARD, JSON.stringify([...new Set([...heard(), ...keys])].slice(-HEARD_KEEP))); } catch { /* nothing to remember with */ }
}

type Message = { kind: "took" | "showing"; key: string };
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

/**
 * One page's chime: feed it every snapshot. The first one only learns; after it, a key not heard before chimes once,
 * unless a visible tab is showing that subject, or another tab took it first.
 */
export function createChime(play: () => void = playChime, now: () => { visible: boolean; path: string } = () => ({ visible: document.visibilityState === "visible", path: location.pathname })) {
  let known: Set<string> | null = null;
  const taken = new Set<string>();
  let channel: BroadcastChannel | null = null;
  try { channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL); } catch { channel = null; }
  if (channel !== null) channel.onmessage = event => {
    const message = event.data as Message;
    if (message && typeof message.key === "string") taken.add(message.key);
  };
  return {
    see(states: readonly BrowserProjectState[]): void {
      const keys = chimeKeysOf(states);
      const before = known;
      known = new Set(keys.keys());
      // A visible tab showing a subject says so, so no other tab chimes for it.
      const here = now();
      for (const [key, href] of keys) if (here.visible && href === here.path) { taken.add(key); channel?.postMessage({ kind: "showing", key } satisfies Message); }
      if (before === null) { remember([...keys.keys()]); return; }
      const old = new Set(heard());
      const fresh = [...keys.keys()].filter(key => !before.has(key) && !old.has(key));
      if (fresh.length === 0) return;
      remember(fresh);
      if (!chimeOn()) return;
      window.setTimeout(() => {
        const mine = fresh.filter(key => !taken.has(key));
        if (mine.length === 0) return;
        for (const key of mine) { taken.add(key); channel?.postMessage({ kind: "took", key } satisfies Message); }
        play();
      }, CHIME_SETTLE_MS * Math.random());
    },
    close(): void { channel?.close(); },
  };
}
