/** Put-away checks (v144, docs/plans/task-tidy.md), in a leaf module so every door can ask without loading the store. */
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
