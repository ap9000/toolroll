/**
 * The last answer of each check a page shows (docs/plans/get-side-effects.md). A page reads `known`; the background
 * checks and a person's Check now (a POST) call `run`. One per console, held in memory: a restart asks again.
 */
export type LastCheck<T> = { at: number; value: T };

export class LastChecks {
  private readonly answers = new Map<string, LastCheck<unknown>>();
  private readonly running = new Map<string, Promise<unknown>>();

  known<T>(key: string): LastCheck<T> | null {
    return (this.answers.get(key) as LastCheck<T> | undefined) ?? null;
  }

  /** Whether the last answer is older than `everyMs` (or missing). */
  due(key: string, everyMs: number, now = Date.now()): boolean {
    const last = this.answers.get(key);
    return last === undefined || now - last.at >= everyMs;
  }

  /** Run the check (one at a time per key) and keep its answer. */
  run<T>(key: string, check: () => Promise<T>): Promise<T> {
    const pending = this.running.get(key);
    if (pending !== undefined) return pending as Promise<T>;
    const started = check().then(value => { this.answers.set(key, { at: Date.now(), value }); return value; })
      .finally(() => { this.running.delete(key); });
    this.running.set(key, started);
    return started;
  }
}
