/**
 * The one way Toolroll opens a credential-bearing address (a one-time sign-in link: `toolroll demo`, `up`'s greeting,
 * the terminal UI's `w`, `toolroll open --web`) in this computer's browser.
 *
 * A program's arguments are visible to every user of the computer (`ps`), so the link is never one of them:
 * - it goes into a page only this user can read: 0600, in a fresh 0700 folder under a folder of this user's own (the
 *   demo's sandbox, or the database's private run folder), that moves the browser on to it with no referrer;
 * - only the platform's own opener is started (`open` on macOS, `xdg-open` on Linux), with that page's path as its one
 *   argument. No override is honoured: TOOLROLL_BROWSER_COMMAND (operate.ts openBrowser) is for addresses that carry no
 *   credential. Anywhere else there is no opener, and nothing is written or opened;
 * - the page is deleted once the link is spent (the console's ledger records the one-time sign-in), when the link
 *   expires, or when this process stops — whichever comes first. A check that fails deletes it too.
 */
import { spawn as spawnChild, type SpawnOptions } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SIGN_IN_LINK_MS } from "./server/session.js";
import type { Store } from "./store.js";

/** How the opener is started (child_process.spawn's shape). Tests hand in their own to see exactly what it was given. */
export type SignInOpener = (command: string, args: string[], options: SpawnOptions) => { unref(): void };

/** The platform's own opener, or null where Toolroll knows none it can hand a path to safely. */
export function platformOpener(platform: NodeJS.Platform = process.platform): "open" | "xdg-open" | null {
  return platform === "darwin" ? "open" : platform === "linux" ? "xdg-open" : null;
}

const PAGE_FOLDER = /^sign-in-[A-Za-z0-9]{6}$/;

/** A page only this user can read that moves the browser on to `link`: its path, in a fresh 0700 folder under `parent`.
 * Pages a stopped process left behind there (older than a link lives) go first. */
export function writeSignInPage(parent: string, link: string, now: number = Date.now()): string {
  sweepSignInPages(parent, now);
  const dir = mkdtempSync(join(parent, "sign-in-"));
  chmodSync(dir, 0o700);
  const file = join(dir, "open.html");
  // The link is origin + /login/once/<base64url>: nothing in it needs escaping, but it is quoted for both places anyway.
  const attribute = link.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  writeFileSync(file, `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer">`
    + `<meta http-equiv="refresh" content="0;url=${attribute}"><title>Toolroll</title>`
    + `<script>location.replace(${JSON.stringify(link).replace(/</g, "\\u003c")})</script><p>Opening Toolroll…</p>\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

/** Remove a page writeSignInPage made (its folder with it). */
export function removeSignInPage(file: string): void {
  rmSync(join(file, ".."), { recursive: true, force: true });
}

/** Page folders under `parent` older than a link lives: a process that was killed outright never removed its own. Only
 * this user's own plain folders with the page folder's name are touched; anything unreadable is left alone. */
function sweepSignInPages(parent: string, now: number): void {
  let names: string[];
  try { names = readdirSync(parent); } catch { return; }
  const uid = process.getuid?.() ?? -1;
  for (const name of names) {
    if (!PAGE_FOLDER.test(name)) continue;
    try {
      const info = lstatSync(join(parent, name));
      if (!info.isDirectory() || (uid >= 0 && info.uid !== uid) || now - info.mtimeMs < SIGN_IN_LINK_MS) continue;
      rmSync(join(parent, name), { recursive: true, force: true });
    } catch { /* left as it is */ }
  }
}

/**
 * Open a sign-in page with the platform's own opener only, with the page's path as its one argument. No override
 * (TOOLROLL_BROWSER_COMMAND or any other) is honoured. False where there is no opener or it couldn't start.
 */
export function openSignInPage(file: string, spawn: SignInOpener = spawnChild, platform: NodeJS.Platform = process.platform): boolean {
  const command = platformOpener(platform);
  if (command === null) return false;
  try { spawn(command, [file], { detached: true, stdio: "ignore" }).unref(); return true; } catch { return false; }
}

/**
 * Whether a one-time link minted from now on has been spent: the console records each one-time sign-in in the ledger
 * ("one-time link" for an account's link, "local link" for a local owner's), never the link itself. Rows from before
 * this call never count. `account` null: whoever it signed in (a local owner's link names no account).
 */
export function ledgerSpent(store: Store, outcome: "one-time link" | "local link", account: string | null): () => boolean {
  const sinceRow = store.handle.prepare("SELECT coalesce(max(id), 0) AS id FROM action_ledger").get();
  const since = Number(sinceRow?.["id"] ?? 0);
  const spent = store.handle.prepare("SELECT actor FROM action_ledger WHERE id > ? AND source = 'sign-in' AND action = 'signed in' AND outcome = ?");
  return () => spent.all(since, outcome).some(row => account === null || row["actor"] === account);
}

/** Every page this process still holds, removed when it ends (a stop it didn't get to clean up after). */
const held = new Set<() => void>();
let exitHooked = false;
function holdUntilExit(finish: () => void): void {
  held.add(finish);
  if (exitHooked) return;
  exitHooked = true;
  process.once("exit", () => { for (const one of [...held]) one(); });
}

/**
 * Delete the page once `spent` says its link is spent, and at the latest when the link expires. A check that throws
 * deletes it too. Returns a stop that deletes it now; this process ending does the same.
 */
export function removeSignInPageWhenSpent(file: string, spent: () => boolean, options: { everyMs?: number; expiresMs?: number; onEnd?: () => void } = {}): () => void {
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    held.delete(finish);
    clearInterval(timer);
    clearTimeout(expiry);
    removeSignInPage(file);
    try { options.onEnd?.(); } catch { /* the page is gone either way */ }
  };
  const timer = setInterval(() => { try { if (spent()) finish(); } catch { finish(); } }, options.everyMs ?? 500);
  const expiry = setTimeout(finish, options.expiresMs ?? SIGN_IN_LINK_MS);
  timer.unref?.();
  expiry.unref?.();
  holdUntilExit(finish);
  return finish;
}

export type SignInOpen = {
  /** A folder of this user's own the page's folder is made in. */
  parent: string;
  /** Whether the link has been spent (ledgerSpent). */
  spent: () => boolean;
  opener?: SignInOpener;
  platform?: NodeJS.Platform;
  everyMs?: number;
  expiresMs?: number;
  /** Called once the page is gone (to close what `spent` reads). */
  onEnd?: () => void;
};

/**
 * Open `link` in this computer's browser through a page (above). `opened` false: nothing was opened, and nothing is
 * left behind. `stop` deletes the page now.
 */
export function openSignInLink(link: string, options: SignInOpen): { opened: boolean; stop: () => void } {
  const platform = options.platform ?? process.platform;
  const end = (): void => { try { options.onEnd?.(); } catch { /* nothing to keep */ } };
  if (platformOpener(platform) === null) { end(); return { opened: false, stop: () => {} }; }
  let file: string;
  try { file = writeSignInPage(options.parent, link); } catch { end(); return { opened: false, stop: () => {} }; }
  const stop = removeSignInPageWhenSpent(file, options.spent, {
    ...(options.everyMs === undefined ? {} : { everyMs: options.everyMs }),
    ...(options.expiresMs === undefined ? {} : { expiresMs: options.expiresMs }),
    ...(options.onEnd === undefined ? {} : { onEnd: options.onEnd }),
  });
  if (!openSignInPage(file, options.opener ?? spawnChild, platform)) { stop(); return { opened: false, stop: () => {} }; }
  return { opened: true, stop };
}
