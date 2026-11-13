import { writeAdvancedPreference, type Store } from "../src/store.js";

/**
 * Settings → Advanced on for every account here now. A new account's menus leave the advanced entry points out (the
 * eight plan, W4), so a test of an advanced feature's own links and sections turns them on first, as a person would.
 */
export function advancedOnForEveryone(store: Store, now = new Date()): void {
  for (const one of store.listApprovers()) if (!writeAdvancedPreference(store, one.name, true, now)) throw new Error(`advanced for ${one.name}`);
}
