/**
 * The one door for writing a task's state (docs/plans/task-state-moves.md).
 *
 * A task is in one of five states: queued, running, done, failed, cancelled. TASK_MOVES lists every way code moves
 * a task between them today: the state it writes and the states it may move from. moveTask writes one move as ONE
 * statement, so the from-check and the write happen together inside whatever transaction the caller is in.
 *
 * Each from-list is copied from the statement it replaced, so this table records current behaviour exactly. The
 * three moves marked `from: "any"` (complete, exhaust, set) have no from-check today and callers rely on that; making
 * them narrower is a behaviour change with its own plan ("Decisions not taken here").
 *
 * Cancellation is not a move here: it has its own door, Store.applyCancellation, which also records why and who.
 * Task creation (INSERT ... 'queued') is not a move either.
 *
 * This file imports nothing from store.ts at runtime (store.ts calls it), only types.
 */
import type { TaskState } from "./store.js";

type MoveTarget = Exclude<TaskState, "cancelled">;
type MoveRule = {
  readonly to: MoveTarget | readonly MoveTarget[];
  readonly from: readonly TaskState[] | "any";
};

const ALL_BUT_CANCELLED = ["queued", "running", "done", "failed"] as const satisfies readonly MoveTarget[];

export const TASK_MOVES = {
  /** Back to the queue from a running attempt that ended without finishing (stop, service stop, sign-in expired,
   * vanished builder, move to a fallback agent). */
  requeue: { to: "queued", from: ["running"] },
  /** An unfinished task that cannot go on (retries stopped, fallback agent signed out). */
  giveUp: { to: "failed", from: ["queued", "running"] },
  /** A person's Retry. */
  retry: { to: "queued", from: ["failed", "queued", "done"] },
  /** The tracker item was opened again. */
  reopen: { to: "queued", from: ["cancelled", "failed", "queued"] },
  /** The fenced completion of an attempt. Wide today: a late result still writes over a closed task. */
  complete: { to: ["done", "failed"], from: "any" },
  /** Strikes used up (build and scouting). Wide today: it writes failed whatever the state was. */
  exhaust: { to: "failed", from: "any" },
  /** Store.setTaskState (the state verb, backend.setState, claim, release and others). Wide by design: it is the
   * general-purpose write; cancelled goes through applyCancellation instead. */
  set: { to: ALL_BUT_CANCELLED, from: "any" },
} as const satisfies Record<string, MoveRule>;

export type TaskMoveName = keyof typeof TASK_MOVES;

/** The smallest database handle moveTask needs (Store.handle fits). */
export type MoveDatabase = {
  prepare(sql: string): { run(...params: unknown[]): { changes: number | bigint } };
};

/** The SQL for one move: the guard is built from the table's own constants, never from caller input. */
function moveSql(rule: MoveRule): string {
  const base = "UPDATE task SET state = ?, updated_at = ? WHERE id = ?";
  if (rule.from === "any") return base;
  return `${base} AND state IN (${rule.from.map(state => `'${state}'`).join(", ")})`;
}

/** The state a move writes; throws on a call that does not fit the table (a programming error, not a refusal). */
function targetOf(name: string, rule: MoveRule, to: TaskState | undefined): MoveTarget {
  if (to === "cancelled") throw new Error("moveTask never writes cancelled: use applyCancellation");
  if (typeof rule.to === "string") {
    if (to !== undefined) throw new Error(`the ${name} move always writes ${rule.to}; do not pass a target`);
    return rule.to;
  }
  if (to === undefined) throw new Error(`the ${name} move needs a target (${rule.to.join(" or ")})`);
  if (!rule.to.includes(to as MoveTarget)) throw new Error(`the ${name} move cannot write ${to}`);
  return to as MoveTarget;
}

/**
 * Move one task. One statement: the from-check and the write together. True when the row changed (false when the
 * task does not exist or is not in one of the move's from-states). `to` is required for complete and set, and
 * refused for every other move.
 */
export function moveTask(db: MoveDatabase, id: string, move: TaskMoveName, now: Date, to?: TaskState): boolean {
  const rule: MoveRule | undefined = Object.hasOwn(TASK_MOVES, move) ? TASK_MOVES[move] : undefined;
  if (rule === undefined) throw new Error(`unknown task move: ${String(move)}`);
  const state = targetOf(move, rule, to);
  return Number(db.prepare(moveSql(rule)).run(state, now.toISOString(), id).changes) > 0;
}

/**
 * SQL condition, true while a runner holds a live claim on the task: the claim is not released, has not expired, and
 * is the newest generation for its task. It needs the `claim` table in scope under that name, and binds one
 * parameter: the current time as an ISO string. This is ownership, not proof that a process is alive.
 */
export const claimedNowSql =
  "claim.released_at IS NULL AND claim.expires_at > ? AND claim.lease_generation = (SELECT MAX(newest.lease_generation) FROM claim AS newest WHERE newest.task_ref = claim.task_ref)";

/**
 * SQL condition, true when the task's stored state is running (the `task` table in scope under that name). A task
 * can be marked running with no live claim (see claimedNowSql), so the two can count differently.
 */
export const markedRunningSql = "task.state = 'running'";
