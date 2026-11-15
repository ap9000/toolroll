/**
 * Flexible threads, slice F2b: how the writers that end a relay call's authority tell the relay at once (the relay's
 * own poll is the second line, for another Toolroll process). A turn ending (finished, interrupted) and a relay grant
 * revoked (by its endpoint, or for a whole launch when it is stopped or its custody is left unresolved) each call
 * `relayCancel` right after their write; every running relay in this process cuts the matching calls before forwarding
 * another byte. Over-cancelling (a write that then rolls back) only ever ends a call early. Nothing here grants anything.
 */
export type RelayCancel = { turn?: string; launch?: string; digest?: string };
type Listener = { hear: (cancel: RelayCancel) => void; failed: () => void };
const listeners = new Set<Listener>();

/** Hear every cancellation (a relay, while it runs). `failed` runs when `hear` throws: the relay must then cut every call
 * it is forwarding, since it can't tell which lost their authority. The return value stops listening. */
export function onRelayCancel(hear: (cancel: RelayCancel) => void, failed: () => void): () => void {
  const listener = { hear, failed };
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Tell every running relay in this process that calls matching `cancel` lost their authority. A relay that can't hear it
 * cuts all of its calls; one relay's trouble never stops another hearing. */
export function relayCancel(cancel: RelayCancel): void {
  for (const listener of [...listeners]) {
    try { listener.hear(cancel); }
    catch { try { listener.failed(); } catch { /* the relay's own poll (and its read-failure rule) is the last line */ } }
  }
}
