/**
 * Stand-in Claude sign-ins for thread tests (flexible-sign-in.ts): a made-up setup-token (built from pieces at run time,
 * never a real one), and a person's sign-in as their own save leaves it — an active row at their account's generation
 * and the value at its own address in the test's own files store (test/setup-state.ts: TOOLROLL_SECRET_STORE=files).
 * The product's save itself (stage, place, activate) is proved in src/flexible-sign-in.test.ts.
 */
import { randomBytes } from "node:crypto";
import { createSignInSecret } from "../src/tool-secret-store.js";
import type { Store } from "../src/store.js";

/** A value shaped like a `claude setup-token` token, made up now. */
export const standInToken = (): string => ["sk", "ant", "oat01", randomBytes(24).toString("hex")].join("-");

/** `person`'s own active sign-in, saved as their save would leave it; returns its generation and value. */
export function standInSignIn(store: Store, state: string, person: string, value: string = standInToken(), now: Date = new Date()): { generation: string; value: string } {
  const account = store.accountOf(person);
  if (account === null) throw new Error(`no account ${person}`);
  const generation = randomBytes(16).toString("hex");
  store.transact(() => {
    store.handle.prepare("UPDATE flexible_sign_in SET state = 'retiring', retired_at = ? WHERE person = ? AND state = 'active'").run(now.toISOString(), person);
    store.handle.prepare(`INSERT INTO flexible_sign_in (person, account_generation, generation, kind, state, save_op, proof, staged_at, activated_at)
      VALUES (?, ?, ?, 'setup-token', 'active', NULL, 'password-now', ?, ?)`).run(person, account.generation, generation, now.toISOString(), now.toISOString());
  });
  if (createSignInSecret(state, { person, generation, kind: "setup-token", value }) !== "ok") throw new Error("a stand-in sign-in's address was taken");
  return { generation, value };
}

/** `person`'s sign-ins all retired (as a removal leaves them). */
export function removeStandInSignIn(store: Store, person: string, now: Date = new Date()): void {
  store.handle.prepare("UPDATE flexible_sign_in SET state = 'retiring', save_op = NULL, retire_after = NULL, retired_at = ? WHERE person = ? AND state IN ('staged', 'active')").run(now.toISOString(), person);
}
