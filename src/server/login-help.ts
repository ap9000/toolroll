/**
 * What the sign-in page's footer tells someone who can't sign in, by install kind. The page is unauthenticated and can
 * be reached from another device (a tailnet, a LAN), so it says only what helps the person at the other computer:
 * where the first password is saved — with the home folder written `~`, never the absolute home folder or the user's
 * name — and the command that resets a forgotten one. Whether the saved file still holds a working password is never
 * checked here: an unauthenticated page never reads or verifies a secret, it only looks whether the file is there.
 */
import { lstatSync, realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, sep } from "node:path";
import { savedLoginFile } from "../login-secrets.js";
import { localOwnerBinding, type Store } from "../store.js";

export type LoginHelp =
  /** A password install: `savedAt` is the saved first password's path as shown (null: not there, or not showable). */
  | { kind: "password"; savedAt: string | null }
  /** A password-free (local mode) install: `passwordSet` says whether any active account has a password to reset. */
  | { kind: "local"; passwordSet: boolean }
  /** The demo: its login lives in its own sandbox, and nothing here resets it. */
  | { kind: "none" };

/**
 * A path as the page may show it: under the home folder, written `~/…`; elsewhere as it is, unless one of its parts is
 * this user's name (a home folder by another route), when it is not shown at all (null).
 */
export function shownPath(path: string, home: string, user: string | null): string | null {
  const homes = new Set([home]);
  try { homes.add(realpathSync(home)); } catch { /* the home folder as given */ }
  for (const one of homes) {
    if (one === "" || one === sep) continue;
    if (path === one) return "~";
    if (path.startsWith(one + sep)) return `~${path.slice(one.length)}`;
  }
  if (user !== null && user !== "" && path.split(/[\\/]/).includes(user)) return null;
  return path;
}

const regularFile = (path: string): boolean => {
  try { return lstatSync(path).isFile(); } catch { return false; }
};

/** The database file this store opened ("" for an in-memory one). */
function databaseFileOf(store: Store): string {
  const row = store.handle.prepare("PRAGMA database_list").all().find(one => one["name"] === "main");
  return typeof row?.["file"] === "string" ? row["file"] : "";
}

/** Whether any active account signs in with a password of its own (not an identity-provider-only account, not a
 * password-free owner's placeholder). */
function anyPasswordSet(store: Store): boolean {
  return store.handle.prepare("SELECT 1 AS one FROM approver WHERE revoked_at IS NULL AND password_set = 1 AND credential_hash NOT LIKE 'sso-only$%' LIMIT 1").get() !== undefined;
}

/** The footer's facts for this install, read now. Never throws: anything unreadable reads as "nothing to show". */
export function loginHelpOf(store: Store, where: { home?: string; user?: string | null } = {}): LoginHelp {
  try {
    if (store.isDemo()) return { kind: "none" };
    if (localOwnerBinding(store) !== null) return { kind: "local", passwordSet: anyPasswordSet(store) };
    const database = databaseFileOf(store);
    if (database === "") return { kind: "password", savedAt: null };
    const saved = savedLoginFile(dirname(database));
    if (!regularFile(saved)) return { kind: "password", savedAt: null };
    let user: string | null = where.user === undefined ? null : where.user;
    if (where.user === undefined) { try { user = userInfo().username; } catch { user = null; } }
    return { kind: "password", savedAt: shownPath(saved, where.home ?? homedir(), user) };
  } catch {
    return { kind: "password", savedAt: null };
  }
}
