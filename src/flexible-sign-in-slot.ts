/**
 * The slot in a person's Claude sign-in address (tool-secret-store.ts signInAddress): the first 16 hex characters of a
 * SHA-256 of their name. An address, never a secret, and not proof of whose a secret is: two names may share a slot, so
 * what rests at an address names its person and generation, and every read checks both. Its own module so a test can
 * force two names into one slot.
 */
import { createHash } from "node:crypto";

export function signInSlot(person: string): string {
  return createHash("sha256").update(`toolroll:flexible-sign-in:${person}`, "utf8").digest("hex").slice(0, 16);
}
