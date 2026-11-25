/**
 * Send back and build for a signed-in approver (everyday 9 A6, Codex round 1 finding 3): whether the ordinary approval
 * could take this person's yes with an empty password field right now, by the very proofs the Approve button accepts
 * that way (server/tasks.ts, the task approve handler): their session standing in (Passwordless, or a solo install), an
 * identity-provider re-check waiting to be spent, or a password typed on this computer within its window. approve()
 * still decides at the press, inside the revision's transaction (freshlyApprovable keeps a remembered password to
 * everyday work); this only says whether to offer it, and whether to try.
 */
import { freshnessFor, passwordlessSessionFor, ssoNowAvailable, withFreshness } from "../scope.js";
import type { Store } from "../store.js";

/** `preview`: asked from a page (a GET) about the act its form posts to: for whether to show the box, never to authorise. */
export function sessionYesPossible(store: Store, by: string, preview: boolean): boolean {
  return passwordlessSessionFor(store, by) || ssoNowAvailable(by) || withFreshness("approve-standard", () => freshnessFor(by, Date.now(), preview)) !== null;
}
