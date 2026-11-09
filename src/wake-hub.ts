/**
 * One shared wake poller per process (docs/plans/live-wakeups.md, slice 3).
 *
 * Every dispatch loop and build lane used to doze by reading `wakeSeq()` from SQLite every 50 ms on its own, so a
 * service with twelve projects and eight lanes made hundreds of reads a second while idle. The hub keeps ONE timer
 * per store: it runs only while something waits, reads the counter once per beat, and resolves each waiter whose
 * baseline the counter has passed.
 *
 * - A waiter resolves with why: "wake" (the counter moved past its baseline), "deadline" (its time came), or "poke"
 *   (its `until` became true, or someone poked it directly: a stop, a lost lease, a recovered reconciliation).
 * - No lost wakeup. The counter only ever moves forward, so a bump that lands after the caller read its baseline and
 *   before it registered is seen on the very next read. Registration is synchronous; nothing yields in between.
 * - Every waiter is checked on every beat (50 ms, well inside the one-second floor the plan asks for), including its
 *   `until`, which must be cheap and in-memory: it never reads the database.
 * - The hub only gives promptness, never permission: claim and spawn fences re-prove everything after a wake.
 * - Nothing here watches files or listens to commits. The timer is cleared as soon as nobody waits, so a stopped
 *   worker (or a finished test) keeps no timer alive.
 */

export type WakeWhy = "wake" | "deadline" | "poke";

/** Something a caller can poke to end the waits registered with it, now (a stop, a lost lease, a recovery). */
export class WakePoker {
  private readonly listeners = new Set<() => void>();
  poke(): void {
    for (const listener of [...this.listeners]) listener();
  }
  /** @internal */
  listen(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

export type WakeWaiter = {
  /** The counter value the caller last acted on. Any later value wakes it. */
  baseline: number;
  /** Epoch milliseconds: resolve with "deadline" once the clock reaches it. */
  deadline: number;
  /** A cheap, in-memory condition checked every beat (never a database read); true resolves with "poke". */
  until?: () => boolean;
  /** Pokes on this end the wait at once with "poke". */
  poker?: WakePoker;
};

export type WakeHubOptions = {
  /** How often the one timer reads the counter while something waits. */
  intervalMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

type Entry = WakeWaiter & { settle: (why: WakeWhy) => void; fail: (error: unknown) => void };

export const WAKE_HUB_INTERVAL_MS = 50;

export class WakeHub {
  private readonly waiters = new Set<Entry>();
  private timer: unknown = null;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readsMade = 0;

  constructor(private readonly read: () => number, options: WakeHubOptions = {}) {
    this.intervalMs = options.intervalMs ?? WAKE_HUB_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Wait until the counter passes `baseline`, the deadline comes, or the waiter is poked. */
  changed(waiter: WakeWaiter): Promise<WakeWhy> {
    return new Promise<WakeWhy>((resolve, reject) => {
      let unlisten: () => void = () => {};
      const entry: Entry = {
        ...waiter,
        settle: why => {
          if (!this.waiters.delete(entry)) return;
          unlisten();
          this.idleIfEmpty();
          resolve(why);
        },
        fail: error => {
          if (!this.waiters.delete(entry)) return;
          unlisten();
          this.idleIfEmpty();
          reject(error);
        },
      };
      this.waiters.add(entry);
      if (waiter.poker !== undefined) unlisten = waiter.poker.listen(() => entry.settle("poke"));
      // Already true (a stop that landed before the wait, a deadline in the past): no beat needed.
      if (waiter.until?.() === true) { entry.settle("poke"); return; }
      if (this.now() >= waiter.deadline) { entry.settle("deadline"); return; }
      this.arm();
    });
  }

  /** End every wait in this process now (the service's stop signal). */
  poke(): void {
    for (const entry of [...this.waiters]) entry.settle("poke");
  }

  /** How many waits are open (tests and diagnostics). */
  waiting(): number { return this.waiters.size; }

  /** Whether the beat timer is running (tests). */
  running(): boolean { return this.timer !== null; }

  /** How many counter reads the hub has made (tests: one per beat, whatever the number of waiters). */
  reads(): number { return this.readsMade; }

  private arm(): void {
    if (this.timer !== null || this.waiters.size === 0) return;
    this.timer = this.setTimer(() => this.beat(), this.intervalMs);
  }

  private idleIfEmpty(): void {
    if (this.waiters.size > 0 || this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  private beat(): void {
    this.timer = null;
    if (this.waiters.size === 0) return;
    let seq: number;
    try {
      this.readsMade++;
      seq = this.read();
    } catch (error) {
      // A read that fails reaches every waiter, as the loops' own read used to: nothing is silently swallowed.
      for (const entry of [...this.waiters]) entry.fail(error);
      return;
    }
    const now = this.now();
    for (const entry of [...this.waiters]) {
      let stop = false;
      try { stop = entry.until?.() === true; } catch (error) { entry.fail(error); continue; }
      if (stop) entry.settle("poke");
      else if (seq !== entry.baseline) entry.settle("wake");
      else if (now >= entry.deadline) entry.settle("deadline");
    }
    this.arm();
  }
}

const hubs = new WeakMap<object, WakeHub>();

/** The one hub for this store (one per process under `up`, which shares a store across project loops). */
export function wakeHubFor(store: { wakeSeq(): number }): WakeHub {
  let hub = hubs.get(store);
  if (hub === undefined) {
    hub = new WakeHub(() => store.wakeSeq());
    hubs.set(store, hub);
  }
  return hub;
}
