/**
 * A page visit only reads (docs/plans/get-side-effects.md). The server runs every GET and HEAD inside this scope, and
 * the few store reads that used to tidy up as they went (closing an operating mode past its expiry) check it and
 * leave the tidying to the background pass and the paths that act.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const scope = new AsyncLocalStorage<true>();

/** Run a GET or HEAD request's work. */
export function asReadOnlyRequest<T>(work: () => T): T {
  return scope.run(true, work);
}

/** Whether the current work answers a GET or HEAD request. */
export function inReadOnlyRequest(): boolean {
  return scope.getStore() === true;
}
