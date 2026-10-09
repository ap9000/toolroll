/** Small warm touches while the lead works on a chat app: once a turn will take more than a few seconds (its first tool
 * step starts), a 👍 on the owner's message and the app's typing indicator until the turn ends. Best effort only: an
 * app or permission that does not allow it is skipped silently, and nothing here can fail, delay or change the turn. */
import type { LeadProgress } from "./lead-progress.js";

export const WARM_EMOJI = "👍";
/** Telegram and Teams show typing for about five seconds, Discord for ten: refreshed inside the shorter window. */
export const TYPING_REFRESH_MS = 4_000;

export type WarmHooks = {
  /** React to the owner's own message. Absent: the app (or this bot's permission) has no reactions. */
  react?: () => Promise<unknown>;
  /** Show the app's typing indicator once. Absent: the app has none for bots. */
  typing?: () => Promise<unknown>;
};

export type WarmTurn = { onProgress: (event: LeadProgress) => void; stop: () => void };

/** The turn's progress listener: on the first tool step, react once and keep typing shown until `stop`. */
export function warmTurn(hooks: WarmHooks, options: { refreshMs?: number } = {}): WarmTurn {
  let started = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const quietly = (call: (() => Promise<unknown>) | undefined): void => {
    if (call === undefined || stopped) return;
    try { void call().catch(() => undefined); } catch { /* skipped silently */ }
  };
  return {
    onProgress: event => {
      if (stopped || event.kind !== "tool" || started) return;
      started = true;
      quietly(hooks.react);
      quietly(hooks.typing);
      if (hooks.typing !== undefined) {
        timer = setInterval(() => quietly(hooks.typing), options.refreshMs ?? TYPING_REFRESH_MS);
        timer.unref?.();
      }
    },
    stop: () => {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
