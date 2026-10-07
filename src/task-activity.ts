/**
 * What a running agent did last, recorded and read (live tasks).
 *
 * The recorder sits beside the live log on the agent's stream and keeps one
 * row per run: a fixed kind from live.ts's vocabulary and when. No text, no
 * tool names, no arguments are ever kept, so nothing here can leak a secret.
 * The reader picks the newer of that row and the run's latest progress
 * checkpoint, and asks the runner's heartbeat whether the worker still
 * answers. Neither side reads or stats a live-log file.
 */
import { ACTIVITY_WORDS, type RunActivity } from "./activity-line.js";
import { liveActivityKind, type LiveActivityKind } from "./live.js";
import { isAlive } from "./runner.js";
import type { Store } from "./store.js";

/** At most one write per run this often while the kind stays the same: the age is in seconds, not milliseconds. */
const SAME_KIND_EVERY_MS = 5_000;

type Observer = { observe(event: Record<string, unknown>): void; close(): void };

/** Watch a run's stream for what the agent does, alongside its live log (which may be null). Fail-soft: a write
 * that fails never touches the run. */
export function withRunActivity(liveLog: Observer | null, store: Pick<Store, "recordRunActivity">, run: number, clock: () => Date): Observer {
  let last: { kind: LiveActivityKind; at: number } | null = null;
  return {
    observe(event) {
      liveLog?.observe(event);
      const kind = liveActivityKind(event);
      if (kind === null) return;
      try {
        const now = clock();
        if (last !== null && last.kind === kind && now.getTime() - last.at < SAME_KIND_EVERY_MS) return;
        store.recordRunActivity(run, kind, now);
        last = { kind, at: now.getTime() };
      } catch { /* display state: the next event tries again */ }
    },
    close() { liveLog?.close(); },
  };
}

/** A live run's last activity: the newer of its recorded kind and its latest progress checkpoint, else when it
 * started; and "offline" only when its registered worker's heartbeat has lapsed. */
export function runActivityOf(store: Store, run: { id: number; runner: string; startedAt: string }, now: Date): RunActivity {
  const recorded = store.runActivity(run.id);
  let what = ACTIVITY_WORDS["started"]!, at = run.startedAt;
  if (recorded.kind !== null && recorded.at !== null && recorded.at >= at) { what = ACTIVITY_WORDS[recorded.kind] ?? ACTIVITY_WORDS["tool"]!; at = recorded.at; }
  if (recorded.progressAt !== null && recorded.progressAt > at) { what = ACTIVITY_WORDS["progress"]!; at = recorded.progressAt; }
  const worker = store.getRunner(run.runner)?.runner;
  return { what, at, worker: worker === undefined || isAlive(worker, now) ? "online" : "offline" };
}
