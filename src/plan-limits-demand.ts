/**
 * When the plan-limits loop may ask the providers anything (everyday 9, B3). Reading Claude's limits costs a real model
 * turn (`claude -p . --model haiku`), so an idle Toolroll must never do it: the loop beside the console only reads while
 * agent work is queued or running (tasks, threads, Direct Chats, the lead's queue), or for ten minutes after a person
 * opens a page that shows plan limits (Spend). Nothing here starts a read; it only answers whether one is wanted.
 */
import type { Store } from "./store.js";

/** How long opening a page that shows plan limits keeps them fresh. */
export const PLAN_LIMITS_VIEW_WINDOW_MS = 10 * 60_000;
/** A queued task counts as work only this soon after it was queued: a task parked in the queue for days is not. */
const QUEUED_RECENTLY_MS = 60 * 60_000;
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

/** Whether agent work is queued or running right now: a task, a build run, a thread turn, a Direct Chat turn, or the
 * lead's queue. Each table is read alone, so one missing on an older database answers "no" for itself only. */
export function agentWorkActive(store: Store, now: Date): boolean {
  const queuedSince = new Date(now.getTime() - QUEUED_RECENTLY_MS).toISOString();
  const runningSince = new Date(now.getTime() - RUNNING_AT_MOST_MS).toISOString();
  return any(store, "SELECT 1 FROM task WHERE state = 'running' OR (state = 'queued' AND updated_at > ?) LIMIT 1", queuedSince)
    || any(store, "SELECT 1 FROM run WHERE outcome IS NULL AND started_at > ? LIMIT 1", runningSince)
    || any(store, "SELECT 1 FROM thread_turn WHERE status IN ('admitted', 'running') AND admitted_at > ? LIMIT 1", runningSince)
    || any(store, "SELECT 1 FROM direct_chat_turn WHERE status = 'running' AND created_at > ? LIMIT 1", runningSince)
    || any(store, "SELECT 1 FROM lead_queue WHERE status IN ('queued', 'running') LIMIT 1");
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
