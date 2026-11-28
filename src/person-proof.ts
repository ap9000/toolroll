/**
 * Whose proof an approval rests on (docs/plans/approval-policy.md): a person's, or a machine credential standing in for
 * one. Kept apart from scope.ts so the release tool can read it without the store.
 */
import type { AuthMethod } from "./scope.js";

/** Every credential method, classified: a person proved now (or by their own remembered sign-in), or a machine
 * credential standing in for them. A new method fails to compile here until someone decides which it is. */
const METHOD_IS_PERSON: Record<AuthMethod, boolean> = {
  "password-now": true, "sso-now": true, "fresh-password": true, "fresh-sso": true, "session": true, "cli-login": true,
  "remote-token": false, "lead-token": false,
  // Easy-start C1: the laptop's own owner in an allowlisted act — a person, standing only while local mode stays on at
  // the generation it was given under (approval-authority.ts localSealStandsSql).
  "local-owner": true,
};
/** Proofs that aren't credential methods: the paired-chat tap, the phone plan's passkey ceremony, and its bounded fresh session window. */
const OTHER_PERSON_PROOFS: ReadonlySet<string> = new Set(["chat", "passkey", "passkey-fresh"]);

/** Every proof that is a person's, in one list: the SQL dispatch predicate (approval-authority.ts) reads this same list. */
export const PERSON_PROOFS: readonly string[] = Object.freeze([
  ...Object.entries(METHOD_IS_PERSON).filter(([, person]) => person).map(([method]) => method),
  ...OTHER_PERSON_PROOFS,
]);

/** Whether a recorded proof is a person's. A runtime string: a missing, corrupt or future value is never a person. */
export function personProof(proof: string | null | undefined): boolean {
  if (typeof proof !== "string") return false;
  return Object.prototype.hasOwnProperty.call(METHOD_IS_PERSON, proof) ? METHOD_IS_PERSON[proof as AuthMethod] : OTHER_PERSON_PROOFS.has(proof);
}
