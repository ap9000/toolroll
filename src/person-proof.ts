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
};
/** Proofs that aren't credential methods: the paired-chat tap, and the phone plan's passkey ceremony. */
const OTHER_PERSON_PROOFS: ReadonlySet<string> = new Set(["chat", "passkey"]);

/** Whether a recorded proof is a person's. A runtime string: a missing, corrupt or future value is never a person. */
export function personProof(proof: string | null | undefined): boolean {
  if (typeof proof !== "string") return false;
  return Object.prototype.hasOwnProperty.call(METHOD_IS_PERSON, proof) ? METHOD_IS_PERSON[proof as AuthMethod] : OTHER_PERSON_PROOFS.has(proof);
}
