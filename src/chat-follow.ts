/** The loop every hosted chat connection (Slack, Discord, Teams) runs over its saved queue. */
import { setTimeout as sleep } from "node:timers/promises";

/** A pause that ends early, and quietly, when `signal` aborts. */
export const abortablePause = (signal: AbortSignal) => async (ms: number): Promise<void> => {
  try {
    await sleep(ms, undefined, { signal });
  } catch {
    /* shutdown */
  }
};

/**
 * Works the queue while this connection stays the current, leased one: each pass takes in saved events, plans room
 * messages, delivers one part and plans notifications (when they are on), checking it is still current between steps.
 * A pass waits while the connection isn't ready (offline, or the provider asked to retry later).
 */
export async function workChatQueue(steps: {
  same: () => boolean;
  ready: () => boolean;
  pause: (ms: number) => Promise<void>;
  notifications: () => boolean;
  process: () => Promise<unknown>;
  rooms: () => Promise<unknown>;
  deliver: () => Promise<unknown>;
  notify: () => Promise<unknown>;
}): Promise<void> {
  while (steps.same()) {
    if (!steps.ready()) {
      await steps.pause(1000);
      continue;
    }
    await steps.process();
    if (steps.same()) await steps.rooms();
    if (steps.same()) await steps.deliver();
    if (steps.same() && steps.notifications()) await steps.notify();
    await steps.pause(1000);
  }
}
