/**
 * Who is acting right now, for pings that follow responsibility.
 *
 * A lead is an agent acting for one person under a lead token (`toolroll lead
 * token`, a `credential` row of kind 'lead', api-tokens.ts): it signs in as that person, and its acts are recorded as "lead for
 * <owner>". A person acting for themselves is recorded by name. Work whose
 * actor is the lead pings nobody, and nobody is pinged about their own act.
 *
 * The actor is held for one command or one console request, never for a
 * long-running service: a worker's facts are nobody's act.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type Actor = { account: string; lead: boolean };

/** The slot is mutable so a command can name its person after it has verified their password. */
const slot = new AsyncLocalStorage<{ actor: Actor | null }>();

/** Run `fn` with this actor (or an empty slot a verified sign-in may fill). */
export function withActor<T>(actor: Actor | null, fn: () => T): T {
  return slot.run({ actor }, fn);
}

export function currentActor(): Actor | null {
  return slot.getStore()?.actor ?? null;
}

/** A person verified their password inside this command: their acts are now theirs. A lead keeps its own label. */
export function claimActor(account: string): void {
  const held = slot.getStore();
  if (held !== undefined && held.actor === null) held.actor = { account, lead: false };
}

/** How the ledger names an actor. */
export function actorLabel(actor: Actor): string {
  return actor.lead ? `lead for ${actor.account}` : actor.account;
}
