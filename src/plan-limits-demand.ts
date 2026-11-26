/**
 * When the plan-limits loop may ask the providers anything (everyday 9, B3). Reading Claude's limits costs a real model
 * turn (`claude -p . --model haiku`), so an idle Toolroll must never do it: the loop beside the console only reads while
 * an agent is actually running (a build or plan on a live lease, a thread turn, a Direct Chat turn, a lead turn), or for
 * ten minutes after a person opens a page that shows plan limits (Spend). Work that only waits — queued, waiting for a
 * plan, Needs you, put away, or a "running" row whose lease lapsed — never counts (everyday-9 C4). Nothing here starts a
 * read; it only answers whether one is wanted.
 */
import type { Store } from "./store.js";
import { realCustodyIO, startIdentityOf } from "./flexible-custody.js";

/** Whether the process `pid` that started as `start` (its recorded start identity) is still that process now. */
export type ProcessAlive = (pid: number, start: string) => boolean;
/** This computer's process table, read once per question and only when a turn names a process. */
function processesNow(): ProcessAlive {
  let io: ReturnType<typeof realCustodyIO> | null = null;
  return (pid, start) => {
    io ??= realCustodyIO(() => null);
    return startIdentityOf(pid, io) === start;
  };
}

/** How long opening a page that shows plan limits keeps them fresh. */
export const PLAN_LIMITS_VIEW_WINDOW_MS = 10 * 60_000;
/** A run or turn with no recorded end counts as running only this long: a row a crash left open never keeps it on. */
const RUNNING_AT_MOST_MS = 6 * 3_600_000;

const viewedAt = new WeakMap<Store, number>();
const listeners = new WeakMap<Store, Set<() => void>>();

/** A person opened a page that shows plan limits: the loop may read for the next ten minutes, starting now. */
export function notePlanLimitsViewed(store: Store, at: Date): void {
  viewedAt.set(store, at.getTime());
  for (const listener of listeners.get(store) ?? []) {
    try { listener(); } catch { /* a listener never breaks the page */ }
  }
}

/** Hear each page open (the loop starts a read at once instead of at its next tick). Returns the way to stop. */
export function onPlanLimitsViewed(store: Store, listener: () => void): () => void {
  const set = listeners.get(store) ?? new Set<() => void>();
  set.add(listener);
  listeners.set(store, set);
  return () => { set.delete(listener); };
}

function any(store: Store, sql: string, ...values: string[]): boolean {
  try { return store.handle.prepare(sql).get(...values) !== undefined; } catch { return false; }
}
/** The (pid, start identity) pairs a query names, or none when its table is missing on an older database. */
function processesOf(store: Store, sql: string, ...values: string[]): { pid: number; start: string }[] {
  try {
    return store.handle.prepare(sql).all(...values).flatMap(row => typeof row["pid"] === "number" && typeof row["start"] === "string" && row["start"] !== ""
      ? [{ pid: row["pid"], start: row["start"] }] : []);
  } catch { return []; }
}

/** Whether an agent is actually running right now, each by the holder that proves it (review round 1): a build or plan
 * run whose worker still holds its lease (a live, unreleased claim: a crashed worker's lease lapses); a running thread
 * turn whose own launch is live and whose leader process is still the one that started (pid and start identity); a
 * running Direct Chat turn whose process is still the one that started; a lead message the lead's queue runs whose bound
 * turn is running within its deadline. A task's own state never counts, nor a "running" row nothing holds: queued,
 * waiting for a plan or a person, a crashed process, a claimed lead message with no turn. Each table is read alone, so
 * one missing on an older database answers "no" for itself only. `alive`: the process check (this computer's table). */
export function agentWorkActive(store: Store, now: Date, alive: ProcessAlive = processesNow()): boolean {
  const at = now.toISOString();
  const runningSince = new Date(now.getTime() - RUNNING_AT_MOST_MS).toISOString();
  const living = (rows: { pid: number; start: string }[]) => rows.some(one => alive(one.pid, one.start));
  return any(store, `SELECT 1 FROM run r JOIN claim c ON c.lease_id = r.lease_id WHERE r.outcome IS NULL AND r.started_at > ?
      AND c.released_at IS NULL AND c.expires_at > ? LIMIT 1`, runningSince, at)
    || any(store, `SELECT 1 FROM lead_queue q JOIN mate_turn m ON m.id = q.turn_id WHERE q.status = 'running' AND q.claimed_at > ?
      AND m.state = 'running' AND m.deadline_at > ? LIMIT 1`, runningSince, at)
    || living(processesOf(store, `SELECT l.leader_pid AS pid, l.leader_start AS start FROM thread_turn t JOIN flexible_thread_launch l ON l.turn = t.id
      WHERE t.status = 'running' AND t.started_at > ? AND l.state = 'live' LIMIT 8`, runningSince))
    || living(processesOf(store, `SELECT pid, start_identity AS start FROM direct_chat_turn WHERE status = 'running' AND created_at > ?
      LIMIT 8`, runningSince));
}

/** Whether the limits loop may read now: work is active, or a person opened plan limits in the last ten minutes. */
export function planLimitsWanted(store: Store, now: Date, alive?: ProcessAlive): boolean {
  const viewed = viewedAt.get(store);
  if (viewed !== undefined && now.getTime() - viewed >= 0 && now.getTime() - viewed < PLAN_LIMITS_VIEW_WINDOW_MS) return true;
  return agentWorkActive(store, now, alive);
}

/** Whether a Direct Chat turn on this provider is running (it uses the person's own sign-in, like a build does). */
export function directChatRunning(store: Store, provider: "claude" | "codex", now: Date): boolean {
  const since = new Date(now.getTime() - RUNNING_AT_MOST_MS).toISOString();
  return any(store, `SELECT 1 FROM direct_chat_turn JOIN direct_chat_thread ON direct_chat_thread.id = direct_chat_turn.thread_id
    WHERE direct_chat_turn.status = 'running' AND direct_chat_turn.created_at > ? AND direct_chat_thread.provider = ? LIMIT 1`, since, provider);
}
