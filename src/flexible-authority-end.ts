/**
 * Threads for everyday use, slice S1 (docs/plans/threads-everyday.md §F2): what ends when the authority a person's
 * thread runs on ends. ONE function, called inside the transaction of every writer that ends it:
 *
 * - every change to an account that moves its generation (store.ts revokeDerivedAuthority: a password changed, reset
 *   or first set, an access change, an identity provider's groups, a revocation);
 * - a person's Claude sign-in for threads removed (by them, or an instance operator from People);
 * - a backup restored (every person's).
 *
 * In that same transaction: the person's active and staged sign-ins retire, their removal epoch moves, every running
 * turn of theirs is interrupted with Toolroll's own words (the words their thread shows), every admitted turn of theirs
 * that never started is withdrawn (it counts toward nothing), and every launch of their threads' agents not yet exited
 * gets a durable stop requirement (flexible_stop_request), which each console's upkeep acts on until that launch's exit
 * is verified, whichever process wrote it. Then every relay in this process cuts their calls at once (relayCancel):
 * the fast path; the record is the one every other process reads.
 *
 * It only ends things: nothing here grants, widens or starts anything. It reads and writes the store's own tables only
 * (never a thread's files), and imports nothing that imports the store.
 */
import { relayCancel } from "./flexible-relay-cancel.js";

type Handle = { prepare(sql: string): { run(...args: unknown[]): { changes: number | bigint }; get(...args: unknown[]): Record<string, unknown> | undefined; all(...args: unknown[]): Record<string, unknown>[] } };
type Writer = { handle: Handle };

/** Why a person's threads lost their authority. */
export type ThreadAuthorityCause = "removed" | "removed-by-operator" | "account-changed" | "restored";

/** What a thread shows when its turn was stopped for each cause (Toolroll's own words, never the agent's). */
export const THREAD_AUTHORITY_WORDS: Readonly<Record<ThreadAuthorityCause, string>> = Object.freeze({
  removed: "Your Claude sign-in for threads was removed, so Toolroll stopped this turn. Add one again, then reply to continue.",
  "removed-by-operator": "An instance operator removed your Claude sign-in for threads, so Toolroll stopped this turn.",
  "account-changed": "Your Toolroll account changed (a password change or reset, or an access change, ends your Claude sign-in for threads), so Toolroll stopped this turn.",
  restored: "Toolroll was restored from a backup, which ends every Claude sign-in for threads, so Toolroll stopped this turn.",
});

const STOP_REASONS: Readonly<Record<ThreadAuthorityCause, string>> = Object.freeze({
  removed: "its owner's Claude sign-in for threads was removed",
  "removed-by-operator": "its owner's Claude sign-in for threads was removed by an instance operator",
  "account-changed": "its owner's Toolroll account changed",
  restored: "Toolroll was restored from a backup",
});

/** Give back the mode's daily start a turn that never started took (flexible-turns.ts releaseRail, the same rule). */
function releaseRail(handle: Handle, turn: Record<string, unknown>): void {
  if (Number(turn["relay_calls"]) !== 0 || turn["started_at"] !== null || Number(turn["rail_reserved"] ?? 0) !== 1) return;
  handle.prepare("UPDATE mode_rail SET reserved_starts = reserved_starts - 1 WHERE repo = ? AND utc_day = ? AND reserved_starts > 0").run(turn["repo"], turn["utc_day"]);
}

/**
 * Require that `launch` (a launch of `thread`'s agent) be stopped, its exit verified. Idempotent: a launch already
 * required keeps its first reason; a launch already exited is settled at once. Inside the caller's transaction.
 */
export function requireFlexibleStop(store: Writer, input: { launch: string; thread: string; reason: string; at: string }): void {
  const reason = input.reason.trim().slice(0, 200) || "Toolroll stopped it";
  store.handle.prepare("INSERT INTO flexible_stop_request (launch, thread, reason, requested_at) VALUES (?, ?, ?, ?) ON CONFLICT (launch) DO NOTHING")
    .run(input.launch, input.thread, reason, input.at);
  settleExitedStops(store, input.at);
}

/** Every open stop requirement whose launch's record already says exited (or is gone) is settled. */
export function settleExitedStops(store: Writer, at: string): number {
  return Number(store.handle.prepare(`UPDATE flexible_stop_request SET settled_at = ? WHERE settled_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM flexible_thread_launch l WHERE l.id = flexible_stop_request.launch AND l.state <> 'exited')`).run(at).changes);
}

/** The open stop requirements (unsettled), oldest first. */
export function openFlexibleStops(store: Writer): { launch: string; thread: string; reason: string }[] {
  return store.handle.prepare("SELECT launch, thread, reason FROM flexible_stop_request WHERE settled_at IS NULL ORDER BY requested_at, launch").all()
    .map(row => ({ launch: String(row["launch"]), thread: String(row["thread"]), reason: String(row["reason"]) }));
}

/**
 * A running turn ends, interrupted, with `words` as its end detail (what its thread shows), and its launch is required
 * to stop. Never anything but a running turn. Inside the caller's transaction; relayCancel after.
 */
export function interruptTurnAndStop(store: Writer, input: { turn: string; words: string; reason: string; at: string; launch?: string | null }): boolean {
  const turn = store.handle.prepare("SELECT thread, billing, cost_basis, status FROM thread_turn WHERE id = ?").get(input.turn);
  if (turn === undefined) return false;
  let ended = false;
  if (turn["status"] === "running") {
    const basis = turn["billing"] === "subscription" ? (turn["cost_basis"] === null ? "unknown" : String(turn["cost_basis"])) : "unknown";
    ended = Number(store.handle.prepare("UPDATE thread_turn SET status = 'interrupted', ended_at = ?, end_detail = ?, cost_basis = ? WHERE id = ? AND status = 'running'")
      .run(input.at, input.words.slice(0, 2000), basis, input.turn).changes) === 1;
  }
  const thread = String(turn["thread"]);
  const launches = input.launch === undefined || input.launch === null
    ? store.handle.prepare("SELECT id FROM flexible_thread_launch WHERE thread = ? AND state <> 'exited'").all(thread).map(row => String(row["id"]))
    : [input.launch];
  for (const launch of launches) requireFlexibleStop(store, { launch, thread, reason: input.reason, at: input.at });
  if (ended) relayCancel({ turn: input.turn });
  return ended;
}

export type ThreadAuthorityEnded = { retired: number; interrupted: number; withdrawn: number; stops: number; threads: string[] };

/**
 * End everything a person's threads run on (see the module comment), inside the caller's transaction. `at` is the
 * caller's time. Returns what it ended, for the caller's words.
 */
export function endThreadAuthorityFor(store: Writer, input: { person: string; cause: ThreadAuthorityCause; at: string;
  /** The caller already retired the sign-ins and moved the epoch itself, in this transaction (removeFlexibleSignIn). */
  signInsEnded?: boolean }): ThreadAuthorityEnded {
  const { handle } = store;
  const words = THREAD_AUTHORITY_WORDS[input.cause];
  const reason = STOP_REASONS[input.cause];
  const retired = input.signInsEnded === true ? 0 : Number(handle.prepare("UPDATE flexible_sign_in SET state = 'retiring', save_op = NULL, retire_after = NULL, retired_at = ? WHERE person = ? AND state IN ('staged', 'active')")
    .run(input.at, input.person).changes);
  // The removal epoch moves for anyone who ever had a sign-in (any call of theirs carries one); a person who never saved
  // one has no call to stop, and their epoch stays as it was.
  const hadSignIn = input.signInsEnded !== true && (retired > 0 || handle.prepare("SELECT 1 AS hit FROM flexible_sign_in WHERE person = ? UNION ALL SELECT 1 AS hit FROM flexible_sign_in_epoch WHERE person = ? LIMIT 1")
    .get(input.person, input.person) !== undefined);
  if (hadSignIn) handle.prepare("INSERT INTO flexible_sign_in_epoch (person, epoch) VALUES (?, 1) ON CONFLICT (person) DO UPDATE SET epoch = epoch + 1").run(input.person);
  handle.prepare("UPDATE flexible_interactive_session SET state = 'ended', ended_at = ?, end_reason = ? WHERE owner = ? AND state <> 'ended'")
    .run(input.at, input.cause, input.person);
  let interrupted = 0, withdrawn = 0;
  const cut: string[] = [];
  for (const turn of handle.prepare("SELECT * FROM thread_turn WHERE owner = ? AND status IN ('admitted', 'running') ORDER BY admitted_at, id").all(input.person)) {
    if (turn["status"] === "admitted") {
      releaseRail(handle, turn);
      withdrawn += Number(handle.prepare("UPDATE thread_turn SET status = 'withdrawn', ended_at = ?, end_detail = ? WHERE id = ? AND status = 'admitted'").run(input.at, words, turn["id"]).changes);
      continue;
    }
    const basis = turn["billing"] === "subscription" ? (turn["cost_basis"] === null ? "unknown" : String(turn["cost_basis"])) : "unknown";
    const done = Number(handle.prepare("UPDATE thread_turn SET status = 'interrupted', ended_at = ?, end_detail = ?, cost_basis = ? WHERE id = ? AND status = 'running'")
      .run(input.at, words, basis, turn["id"]).changes);
    if (done === 1) { interrupted++; cut.push(String(turn["id"])); }
  }
  const threads = new Set<string>();
  let stops = 0;
  for (const launch of handle.prepare(`SELECT l.id AS launch, l.thread AS thread FROM flexible_thread_launch l JOIN flexible_thread t ON t.id = l.thread
    WHERE t.created_by = ? AND l.state <> 'exited' ORDER BY l.started_at, l.id`).all(input.person)) {
    const added = Number(handle.prepare("INSERT INTO flexible_stop_request (launch, thread, reason, requested_at) VALUES (?, ?, ?, ?) ON CONFLICT (launch) DO NOTHING")
      .run(launch["launch"], launch["thread"], reason, input.at).changes);
    stops += added;
    threads.add(String(launch["thread"]));
  }
  relayCancel({ person: input.person });
  for (const turn of cut) relayCancel({ turn });
  return { retired, interrupted, withdrawn, stops, threads: [...threads] };
}
