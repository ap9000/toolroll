/**
 * Flexible threads, slice F2b: how the writers that end a relay call's authority tell the relay at once (the relay's
 * own poll is the second line, for another Toolroll process). A turn ending (finished, interrupted) and a relay grant
 * revoked (by its endpoint, or for a whole launch when it is stopped or its custody is left unresolved) each call
 * `relayCancel` right after their write; every running relay in this process cuts the matching calls before forwarding
 * another byte. Over-cancelling (a write that then rolls back) only ever ends a call early. Nothing here grants anything.
 */
export type RelayCancel = { turn?: string; launch?: string; digest?: string };
const listeners = new Set<(cancel: RelayCancel) => void>();

/** Hear every cancellation (a relay, while it runs); the return value stops listening. */
export function onRelayCancel(listener: (cancel: RelayCancel) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Tell every running relay in this process that calls matching `cancel` lost their authority. */
export function relayCancel(cancel: RelayCancel): void {
  for (const listener of [...listeners]) { try { listener(cancel); } catch { /* one relay's trouble never stops another's */ } }
}
