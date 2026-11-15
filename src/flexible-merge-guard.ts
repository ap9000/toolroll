/**
 * The one rule every merge road asks (the Flexible plan v2 §7, owner decision D3'): a result filed from a Flexible
 * thread (provenance `flexible:<ship>`, immutable) merges only through its own armed Ship (flexible-ship.ts
 * mergeArmedFlexible), and only on a green required check for its exact commit. Every other road refuses it: a
 * person's Merge (`anyway` or not), merge when checks pass, a flow, a chat or MCP merge, the publish sweep and the
 * publish merge and refire commands. Reads only the task's provenance and its Ship's row, so it holds whether Flexible
 * is on or off.
 *
 * Two moments: at the start of a pull-request merge the Ship must be the one the provenance names, completed or
 * already reserved; at the reservation (inside the transaction that reserves the merge, immediately before the call
 * to GitHub) it must be reserved (`merging`) under exactly the token the armed merge holds. A cancel or revocation
 * that lands before the reservation leaves the Ship cancelled, and the merge refuses.
 */
import type { Store } from "./store.js";

export const FLEXIBLE_FILED_PREFIX = "flexible:";
export type MergeRoad = "pull-request" | "merge-when-green" | "publish-sweep" | "publish-merge" | "publish-refire";
export const FLEXIBLE_MERGE_WORDS = "This result came from a Flexible thread. It merges only by itself, through its Ship, after its check passed on this exact commit.";

/** Why `road` may not merge task `taskId`, or null when it may. `authority` is the Ship and reservation token the armed
 * merge carries (mergeArmedFlexible passes them); only a pull-request merge with exactly that Ship, in the state the
 * `moment` requires, and never `anyway`, merges a Flexible result. */
export function flexibleMergeRefusal(store: Store, taskId: string | null, road: MergeRoad, authority: { ship?: string; token?: string; anyway?: boolean } = {},
  moment: "start" | "reserve" = "start"): string | null {
  if (taskId === null) return null;
  const via = store.filedViaOf(taskId);
  if (via === null || !via.startsWith(FLEXIBLE_FILED_PREFIX)) return null;
  if (road !== "pull-request" || authority.anyway === true || authority.ship === undefined || authority.token === undefined || `${FLEXIBLE_FILED_PREFIX}${authority.ship}` !== via) return FLEXIBLE_MERGE_WORDS;
  let row: Record<string, unknown> | undefined;
  try { row = store.handle.prepare("SELECT state, merge_token FROM flexible_ship WHERE id = ? AND task_id = ?").get(authority.ship, taskId) as Record<string, unknown> | undefined; }
  catch { return FLEXIBLE_MERGE_WORDS; }
  if (row === undefined) return FLEXIBLE_MERGE_WORDS;
  if (moment === "start") return row["state"] === "completed" || (row["state"] === "merging" && row["merge_token"] === authority.token) ? null : FLEXIBLE_MERGE_WORDS;
  return row["state"] === "merging" && row["merge_token"] === authority.token ? null : FLEXIBLE_MERGE_WORDS;
}

/** Said when a Flexible Ship's task would have its prepared commit replaced. */
export const FLEXIBLE_CANDIDATE_FIXED = "A Flexible Ship's task checks exactly the commit its Ship imported, so its prepared commit can't be replaced. Ship again from the thread instead.";

/** Why a scope write may not change a task's prepared commit from `previous` to `next`, or null: a Flexible-filed task's
 * prepared commit, once set (by its Ship, to the commit it imported), never changes. */
export function flexibleCandidateChangeRefusal(store: Store, taskId: string, previous: string | null | undefined, next: string | null | undefined): string | null {
  if (previous == null || (next ?? null) === previous) return null;
  return store.filedViaOf(taskId)?.startsWith(FLEXIBLE_FILED_PREFIX) === true ? FLEXIBLE_CANDIDATE_FIXED : null;
}

/**
 * How a build of task `taskId` may take its prepared commit (builder.ts): null for a task not filed from a Flexible
 * thread; for one that is, either the Ship's own import ref to adopt the commit itself from (only when the task is
 * exactly its Ship's, armed or completed, the prepared commit is the Ship's imported candidate and the scope is the one
 * the Ship sealed), or why the build must not commit at all. A Flexible task never falls back to an ordinary commit.
 */
export function flexibleAdoption(store: Store, taskId: string, prepared: string | null, scopeDigest: string | null): { adopt: { importRef: string; candidate: string } } | { refuse: string } | null {
  const via = store.filedViaOf(taskId);
  if (via === null || !via.startsWith(FLEXIBLE_FILED_PREFIX)) return null;
  const refusal = { refuse: "This task came from a Flexible thread, and its prepared commit isn't exactly the commit its Ship imported and sealed, so nothing was committed. Ship again from the thread." };
  let row: Record<string, unknown> | undefined;
  try { row = store.handle.prepare("SELECT id, candidate, import_ref, scope_digest, state FROM flexible_ship WHERE task_id = ?").get(taskId) as Record<string, unknown> | undefined; }
  catch { return refusal; }
  if (row === undefined || via !== `${FLEXIBLE_FILED_PREFIX}${String(row["id"])}` || !["armed", "completed"].includes(String(row["state"]))) return refusal;
  if (prepared === null || prepared !== row["candidate"] || scopeDigest === null || scopeDigest !== row["scope_digest"]) return refusal;
  return { adopt: { importRef: String(row["import_ref"]), candidate: prepared } };
}
