/**
 * Re-running only what failed, by file (docs/plans/release-once.md, part 2). Filled in by phase D.
 */
import type { Store } from "./store.js";

/** The identities a later check of this release still has to run again and pass. */
export function releaseObligationsOf(_store: Store, _root: string, _authority: number): string[] {
  return [];
}
