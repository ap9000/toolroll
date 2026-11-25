import { laptopShipProblem } from "./flexible-laptop.js";
import type { Store } from "./store.js";

/**
 * Pure leaf predicate used by `approve()` in `src/scope.ts` so a passwordless
 * laptop local-owner can seal a verify-only Direct Chat Ship task under the
 * exact `direct-chat-ship` act without creating a circular import with `scope.ts`.
 */
export function directChatShipSealAllowed(
  store: Pick<Store, "handle">,
  input: { by: string; taskId: string; candidate: string | null },
): boolean {
  const match = /^dc-([0-9a-f]{32})$/.exec(input.taskId);
  if (match === null) return false;
  const row = store.handle
    .prepare("SELECT approved_by, state, candidate_sha, proof, local_generation FROM direct_chat_ship WHERE id = ?")
    .get(match[1]) as Record<string, unknown> | undefined;
  if (!row) return false;
  if (
    row["approved_by"] !== input.by
    || row["state"] !== "imported"
    || row["proof"] !== "local-owner"
    || row["candidate_sha"] !== input.candidate
    || typeof row["local_generation"] !== "number"
  ) {
    return false;
  }
  return laptopShipProblem(store, { owner: input.by, localGeneration: row["local_generation"] }) === null;
}
