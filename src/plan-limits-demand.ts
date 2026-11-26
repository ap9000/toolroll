/**
 * When the plan-limits loop may ask the providers anything (everyday 9, B3). Reading Claude's limits costs a real model
 * turn (`claude -p . --model haiku`), so an idle Toolroll must never do it: the loop beside the console only reads while
 * an agent is actually running (a build or plan on a live lease, a thread turn, a Direct Chat turn, a lead turn), or for
 * ten minutes after a person opens a page that shows plan limits (Spend). Work that only waits — queued, waiting for a
 * plan, Needs you, put away, or a "running" row whose lease lapsed — never counts (everyday-9 C4). Nothing here starts a
 * read; it only answers whether one is wanted.
 */
import type { Store } from "./store.js";

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

/** Whether an agent is actually running right now: a build or plan run whose worker still holds its lease (a live,
 * unreleased claim: a crashed worker's lease lapses), a thread turn that started, a Direct Chat turn, or a lead turn the
 * lead's queue is executing. A task's own state never counts: queued, waiting for a plan or a person, or a "running" row
 * nothing holds. Each table is read alone, so one missing on an older database answers "no" for itself only. */
export function agentWorkActive(store: Store, now: Date): boolean {
  const at = now.toISOString();
  const runningSince = new Date(now.getTime() - RUNNING_AT_MOST_MS).toISOString();
  return any(store, `SELECT 1 FROM run r JOIN claim c ON c.lease_id = r.lease_id WHERE r.outcome IS NULL AND r.started_at > ?
      AND c.released_at IS NULL AND c.expires_at > ? LIMIT 1`, runningSince, at)
    || any(store, "SELECT 1 FROM thread_turn WHERE status = 'running' AND started_at > ? LIMIT 1", runningSince)
    || any(store, "SELECT 1 FROM direct_chat_turn WHERE status = 'running' AND created_at > ? LIMIT 1", runningSince)
    || any(store, "SELECT 1 FROM lead_queue WHERE status = 'running' AND claimed_at > ? LIMIT 1", runningSince);
}

/** Whether the limits loop may read now: work is active, or a person opened plan limits in the last ten minutes. */
export function planLimitsWanted(store: Store, now: Date): boolean {
  const viewed = viewedAt.get(store);
  if (viewed !== undefined && now.getTime() - viewed >= 0 && now.getTime() - viewed < PLAN_LIMITS_VIEW_WINDOW_MS) return true;
  return agentWorkActive(store, now);
}

/** Whether a Direct Chat turn on this provider is running (it uses the person's own sign-in, like a build does). */
export function directChatRunning(store: Store, provider: "claude" | "codex", now: Date): boolean {
  const since = new Date(now.getTime() - RUNNING_AT_MOST_MS).toISOString();
  return any(store, `SELECT 1 FROM direct_chat_turn JOIN direct_chat_thread ON direct_chat_thread.id = direct_chat_turn.thread_id
    WHERE direct_chat_turn.status = 'running' AND direct_chat_turn.created_at > ? AND direct_chat_thread.provider = ? LIMIT 1`, since, provider);
}
