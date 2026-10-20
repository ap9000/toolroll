/**
 * Passwordless (docs/plans/passwordless.md): one installation setting. When it is on, signing in is the only
 * password — a step-up is satisfied by the person's live browser session (scope.ts `proveAccountNow`, method
 * "session") or, at this computer's CLI, by its remembered login. Credential acts (the plan's closed list) still
 * take a typed password (`proveCredential`).
 *
 * Like the other policy settings it is an append-only ledger entry; the newest one wins; none means off.
 */
import type { Store } from "./store.js";

export const PASSWORDLESS_ACTION = "passwordless changed";

export type PasswordlessSetting = { on: boolean; setBy: string | null; at: string | null };

/** Read live at every act: a change takes effect on the next one. */
export function passwordlessSetting(store: Store): PasswordlessSetting {
  // Fail closed: a setting that can't be read is off (a step-up then asks for the password, as it always did).
  let row: Record<string, unknown> | undefined;
  try { row = store.handle.prepare("SELECT actor, at, outcome FROM action_ledger WHERE repo IS NULL AND task_id IS NULL AND action = ? ORDER BY id DESC LIMIT 1").get(PASSWORDLESS_ACTION); } catch { return { on: false, setBy: null, at: null }; }
  if (row === undefined || (row["outcome"] !== "on" && row["outcome"] !== "off")) return { on: false, setBy: null, at: null };
  return { on: row["outcome"] === "on", setBy: String(row["actor"]), at: String(row["at"]) };
}

export const passwordlessOn = (store: Store): boolean => passwordlessSetting(store).on;

/** An operator's act (the caller proves it: on takes a typed password, off is one click). The ledger keeps before → after. */
export function setPasswordless(store: Store, on: boolean, by: string, now: Date): { changed: boolean } {
  if (passwordlessOn(store) === on) return { changed: false };
  store.recordAction({ at: now.toISOString(), actor: by, repo: null, taskId: null, runId: null, action: PASSWORDLESS_ACTION, outcome: on ? "on" : "off", source: "policy",
    detail: on ? "Passwordless on: signing in is the only password" : "Passwordless off: step-ups ask for the password again" });
  store.bumpWake();
  return { changed: true };
}

export const PASSWORDLESS_TRADE = "Anyone holding a signed-in browser — an unlocked laptop, a phone, a stolen session — can then do everything you can without a second check. Signing in, session limits (12 hours idle, 7 days), signing out and ending sessions remain your protection. Creating or widening a way in (passwords, sign-in methods, API tokens, connected apps, people, workers, chat pairing, webhook secrets) still asks for your password.";
