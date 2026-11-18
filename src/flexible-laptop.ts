/**
 * Threads for everyday use, slice S7 (the owner's D1, "No password (laptop)"; Codex round 2's finding): the ONE predicate
 * that says whether this install is still one where its local owner may Ship a thread with one key in the workbench.
 * Read again in every transaction that acts on that consent: the press that records it, the seal (flexible-ship.ts
 * fileAndSeal, through approve()'s ship-thread branch), and the armed merge's completion and its reservation. When it
 * fails at any of them the Ship ends for good: putting the settings back never revives it.
 *
 * Eligible only when, read now from Toolroll's own records:
 * - local mode is on, for this owner, at the local generation the consent was bound to (when one is given);
 * - no active account has a password (a second account getting one moves no generation of the owner's, so it is read
 *   here, never inferred);
 * - no identity provider sign-in is linked to any account;
 * - the install is solo (install-mode.ts), and the owner is its only active approver.
 */
import { installModeNow } from "./install-mode.js";
import type { Store } from "./store.js";

/** Why the laptop road doesn't stand now, in plain words, or null when it does. */
export function laptopShipProblem(store: Pick<Store, "handle">, input: { owner: string; localGeneration?: number }): string | null {
  let mode: Record<string, unknown> | undefined;
  try { mode = store.handle.prepare("SELECT owner, generation, enabled FROM local_mode WHERE id = 1").get(); } catch { return "this install's local mode can't be read"; }
  if (mode === undefined || Number(mode["enabled"]) !== 1 || String(mode["owner"]) !== input.owner) return "this install isn't in laptop mode for you";
  if (input.localGeneration !== undefined && Number(mode["generation"]) !== input.localGeneration) return "laptop mode changed since you shipped it";
  if (store.handle.prepare("SELECT 1 AS hit FROM approver WHERE password_set = 1 AND revoked_at IS NULL LIMIT 1").get() !== undefined) return "an account on this install has a password now";
  if (store.handle.prepare("SELECT 1 AS hit FROM sso_identity LIMIT 1").get() !== undefined) return "an identity provider sign-in is linked on this install";
  const approvers = store.handle.prepare("SELECT name FROM approver WHERE revoked_at IS NULL AND role = 'approver'").all().map(row => String(row["name"]));
  if (approvers.length !== 1 || approvers[0] !== input.owner) return "this install has another approver";
  if (installModeNow(store).mode !== "solo") return "this install isn't solo any more";
  return null;
}

/** The laptop consent a Ship was recorded under (flexible_ship_laptop, v174), or null when it took a typed password. */
export function laptopShipBinding(store: Pick<Store, "handle">, ship: string): { owner: string; localGeneration: number; accountGeneration: number } | null {
  const row = store.handle.prepare("SELECT owner, local_generation, account_generation FROM flexible_ship_laptop WHERE ship = ?").get(ship);
  return row === undefined ? null : { owner: String(row["owner"]), localGeneration: Number(row["local_generation"]), accountGeneration: Number(row["account_generation"]) };
}

/**
 * Whether approve() may seal `taskId` for the local owner `by` under the ship-thread act: exactly the verify-only task
 * of a Ship recorded with the laptop consent, by `by`, still imported (nothing sealed yet), whose candidate is the
 * scope's, while the laptop road still stands at the consent's local generation. Read inside approve()'s transaction.
 */
export function laptopShipSealAllowed(store: Pick<Store, "handle">, input: { by: string; taskId: string; candidate: string | null }): boolean {
  const named = /^flexible-([0-9a-f]{32})$/.exec(input.taskId);
  if (named === null) return false;
  const ship = store.handle.prepare("SELECT approved_by, state, candidate, proof FROM flexible_ship WHERE id = ?").get(named[1]);
  if (ship === undefined || ship["approved_by"] !== input.by || ship["state"] !== "imported" || ship["proof"] !== "local-owner" || ship["candidate"] !== input.candidate) return false;
  const binding = laptopShipBinding(store, named[1]!);
  return binding !== null && binding.owner === input.by && laptopShipProblem(store, { owner: input.by, localGeneration: binding.localGeneration }) === null;
}
