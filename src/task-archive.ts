/** Put-away checks (v145, docs/plans/task-tidy.md), in a leaf module so every door can ask without loading the store. */
import type { Store } from "./store.js";

/** Whether this task version is put away. Every door that dispatches, claims or approves asks this (fail closed: a
 * row means no). */
export function refArchived(store: Store, taskRef: number): boolean {
  return store.handle.prepare("SELECT 1 FROM task_archive WHERE task_ref = ?").get(taskRef) !== undefined;
}

/** Whether the built-in task with this id is put away. */
export function taskArchived(store: Store, taskId: string): boolean {
  return store.handle.prepare(`SELECT 1 FROM task_archive a JOIN task_ref r ON r.id = a.task_ref
    WHERE r.backend = 'built-in' AND r.external_id = ?`).get(taskId) !== undefined;
}

/** Whether a flow card's work is put away: its current task or its first build task (a later stage keeps the first
 * and may clear the current one). Read from the card's own row now, so a put away that committed first holds it. */
export function cardTaskArchived(store: Store, cardId: number): boolean {
  return store.handle.prepare(`SELECT 1 FROM flow_card c JOIN task_ref r ON r.backend = 'built-in' AND r.external_id IN (c.task, c.primary_task)
    JOIN task_archive a ON a.task_ref = r.id WHERE c.id = ?`).get(cardId) !== undefined;
}

/** Whether the built-in task with this id is cancelled. Every door that approves, seals or carries a release asks
 * this beside the put-away check: a cancelled task takes no new yes (fail closed), by any road. */
export function taskCancelled(store: Store, taskId: string): boolean {
  return store.handle.prepare("SELECT 1 FROM task WHERE id = ? AND state = 'cancelled'").get(taskId) !== undefined;
}
