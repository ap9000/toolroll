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
  // Off is recorded even when nothing was ever set: an explicit off is what keeps a solo install asking for the password
  // (install-mode.ts sessionStandsIn reads the newest entry).
  const setting = passwordlessSetting(store);
  if (setting.on === on && (on || setting.at !== null)) return { changed: false };
  store.recordAction({ at: now.toISOString(), actor: by, repo: null, taskId: null, runId: null, action: PASSWORDLESS_ACTION, outcome: on ? "on" : "off", source: "policy",
    detail: on ? "Passwordless on: most browser approvals need no password" : "Passwordless off: step-ups ask for the password again" });
  store.bumpWake();
  return { changed: true };
}

export const PASSWORDLESS_TRADE = "Anyone holding a signed-in browser — an unlocked laptop, a phone, a stolen session — can then do everything you can without a second check, except what still asks below. Signing in, session limits (12 hours idle, 7 days), signing out and ending sessions remain your protection.";
/** What still asks for the password with Passwordless on, as the acts' own checks decide it (credential acts never take
 * a session standing in; scope.ts; local-owner.ts LOCAL_PASSWORD_ACTS; flexible-ship.ts and direct-chat-ship.ts ask for
 * a password typed now, except the local owner's own acts on a laptop install, server/direct-chat.ts and flexible-ship.ts;
 * a shell has no browser session). Words only: each act's own check is what asks. */
export const PASSWORDLESS_STILL_ASKS: readonly string[] = Object.freeze([
  "Signing in, and anything that adds or widens a way in: passwords, sign-in methods, API tokens, connected apps, people, workers, chat pairing and webhook secrets.",
  "Widening what a project’s builds and checks reach: its network, where builds write, its home folder and its check commands.",
  "Turning on interactive agent threads and saving the Claude sign-in they use.",
  "Saving or shipping a Direct Chat’s work, and shipping a thread’s, except in Local mode on a laptop install, where this computer’s own browser and workbench don’t ask.",
  "A toolroll command run in a shell without this computer’s remembered login.",
]);
/** How the other ways of skipping the password differ from Passwordless (General's Solo and Local mode, and a password
 * remembered after typing it). */
export const PASSWORDLESS_OTHERS = "Solo stands in the same way while you are the only person on this install. Local mode lets this computer’s browser file tasks, approve plans and add projects with no password at all. Without either, a password you just typed skips standard approvals on this computer for 15 minutes.";
