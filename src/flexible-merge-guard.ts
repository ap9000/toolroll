/**
 * The one rule every merge road asks (the Flexible plan v2 §7, owner decision D3'): a result filed from a Flexible
 * thread (provenance `flexible:<send>`, immutable) merges only through its own armed Ship (flexible-ship.ts
 * mergeArmedFlexible), and only on a green required check for its exact commit. Every other road refuses it: a
 * person's Merge (`anyway` or not), merge when checks pass, a flow, a chat or MCP merge, the publish sweep and the
 * publish merge and refire commands. Reads only the task's provenance, so it holds whether Flexible is on or off.
 */
import type { Store } from "./store.js";

export const FLEXIBLE_FILED_PREFIX = "flexible:";
export type MergeRoad = "pull-request" | "merge-when-green" | "publish-sweep" | "publish-merge" | "publish-refire";
export const FLEXIBLE_MERGE_WORDS = "This result came from a Flexible thread. It merges only by itself, through its Ship, after its check passed on this exact commit.";

/** Why `road` may not merge task `taskId`, or null when it may. `authority` is the Ship send the armed merge carries
 * (mergeArmedFlexible passes it, after re-proving it); only a pull-request merge with exactly that send's authority,
 * and never `anyway`, merges a Flexible result. */
export function flexibleMergeRefusal(store: Store, taskId: string | null, road: MergeRoad, authority: { ship?: string; anyway?: boolean } = {}): string | null {
  if (taskId === null) return null;
  const via = store.filedViaOf(taskId);
  if (via === null || !via.startsWith(FLEXIBLE_FILED_PREFIX)) return null;
  if (road === "pull-request" && authority.anyway !== true && authority.ship !== undefined && `${FLEXIBLE_FILED_PREFIX}${authority.ship}` === via) return null;
  return FLEXIBLE_MERGE_WORDS;
}
