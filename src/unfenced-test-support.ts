/**
 * Tests that run real commands on a machine with no OS fence (CI's Ubuntu runners, where unprivileged namespaces are
 * off) allow unconfined agents on their own store, as an instance operator there would; anywhere a fence exists,
 * nothing changes and the fence is what the test runs under.
 */
import { linuxFenceAvailable, macosFenceAvailable } from "./agent-fence.js";
import type { Store } from "./store.js";

export function allowWhereUnfenced<T extends Store>(store: T): T {
  if (!macosFenceAvailable() && !linuxFenceAvailable()) store.setUnfencedAgentsAllowed(true, "test", new Date(0));
  return store;
}
