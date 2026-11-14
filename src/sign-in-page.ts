/**
 * The one way Toolroll opens a credential-bearing address (a one-time sign-in link: `toolroll demo`, `up`'s greeting,
 * the terminal UI's `w`, `toolroll open --web`) in this computer's browser.
 *
 * A program's arguments are visible to every user of the computer (`ps`), so the link is never one of them:
 * - it goes into a page only this user can read: 0600, in a fresh 0700 folder under a folder of this user's own (the
 *   demo's sandbox, or the database's private run folder), that moves the browser on to it with no referrer;
 * - only the platform's own opener is started (`open` on macOS, `xdg-open` on Linux), with that page's path as its one
 *   argument. No override is honoured: TOOLROLL_BROWSER_COMMAND (operate.ts openBrowser) is for addresses that carry no
 *   credential. Anywhere else there is no opener, and nothing is minted, written or opened (NO_SAFE_OPENER says what to
 *   do instead). An opener that can't be found, fails to start or exits with a failure counts as not opened;
 * - the page is deleted once the link is spent (the console's ledger records the one-time sign-in), when the link
 *   expires (the mint's own deadline), or when this process stops — whichever comes first. A check that fails deletes
 *   it too, and a deletion that fails is tried again a few times.
 */
import { spawn as spawnChild, type ChildProcess, type SpawnOptions } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { SIGN_IN_LINK_MS } from "./server/session.js";
import type { Store } from "./store.js";

/** How the opener is started (child_process.spawn). Tests hand in their own to see exactly what it was given. */
export type SignInOpener = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/** What a person on a computer with no opener Toolroll can hand a page to does instead: a password and the sign-in
 * page. Never a link: nothing here carries a code. */
export const NO_SAFE_OPENER = "this computer can't open a browser for Toolroll safely. To use the browser, run `toolroll password set` and sign in with that password";

/** The platform's own opener, or null where Toolroll knows none it can hand a path to safely. */
export function platformOpener(platform: NodeJS.Platform = process.platform): "open" | "xdg-open" | null {
  return platform === "darwin" ? "open" : platform === "linux" ? "xdg-open" : null;
}

const PAGE_FOLDER = /^sign-in-[A-Za-z0-9]{6}$/;
const PAGE_FILE = "open.html";

/** A page only this user can read that moves the browser on to `link`: its path, in a fresh 0700 folder under `parent`.
 * Pages a stopped process left behind there (older than a link lives) go first; a page that couldn't be finished goes
 * with its folder. */
export function writeSignInPage(parent: string, link: string, now: number = Date.now()): string {
  sweepSignInPages(parent, now);
  const dir = mkdtempSync(join(parent, "sign-in-"));
  const file = join(dir, PAGE_FILE);
  try {
    chmodSync(dir, 0o700);
    // The link is origin + /login/once/<base64url>: nothing in it needs escaping, but it is quoted for both places anyway.
    const attribute = link.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    writeFileSync(file, `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer">`
      + `<meta http-equiv="refresh" content="0;url=${attribute}"><title>Toolroll</title>`
      + `<script>location.replace(${JSON.stringify(link).replace(/</g, "\\u003c")})</script><p>Opening Toolroll…</p>\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return file;
}

/** Remove a page writeSignInPage made, its folder with it — and only that: the path must be a page file directly inside
 * a page folder (a real folder, not a link), or nothing is removed and this throws. */
export function removeSignInPage(file: string): void {
  const dir = dirname(file);
  if (basename(file) !== PAGE_FILE || !PAGE_FOLDER.test(basename(dir))) throw Error(`${file} isn't a sign-in page`);
  let info;
  try { info = lstatSync(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!info.isDirectory()) throw Error(`${dir} isn't a sign-in page's folder`);
  rmSync(dir, { recursive: true, force: true });
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
      removeSignInPage(join(parent, name, PAGE_FILE));
    } catch { /* left as it is */ }
  }
}

/**
 * Open a sign-in page with the platform's own opener only, with the page's path as its one argument. No override
 * (TOOLROLL_BROWSER_COMMAND or any other) is honoured. True once the opener has exited successfully, or is still
 * running `settleMs` after it started (xdg-open can wait on the browser). False where there is no opener, or it can't
 * be found, fails to start, or exits with a failure.
 */
export function openSignInPage(file: string, spawn: SignInOpener = spawnChild, platform: NodeJS.Platform = process.platform, settleMs = 3_000): Promise<boolean> {
  const command = platformOpener(platform);
  if (command === null) return Promise.resolve(false);
  return new Promise<boolean>(resolve => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const end = (opened: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(opened);
    };
    let child: ChildProcess;
    try { child = spawn(command, [file], { detached: true, stdio: "ignore" }); } catch { end(false); return; }
    // A program that isn't there is reported here, after spawn returned: never an uncaught error.
    child.on("error", () => end(false));
    child.once("exit", code => end(code === 0));
    timer = setTimeout(() => end(true), settleMs);
    child.unref();
  });
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

/** How many times a deletion that failed is tried again, and how far apart. */
const REMOVE_RETRIES = 3;
const REMOVE_RETRY_MS = 250;

export type SignInPageWatch = { stop: () => void; gone: Promise<void> };

/**
 * Delete the page once `spent` says its link is spent, and at the latest at `expiresAt` (the link's own deadline, in
 * ms since the epoch). A check that throws deletes it too. `stop` deletes it now; this process ending does the same.
 * `gone` settles once the page has been dealt with. `onEnd` runs once, whatever the deletion did.
 */
export function removeSignInPageWhenSpent(file: string, spent: () => boolean, options: { everyMs?: number; expiresAt?: number; onEnd?: () => void; remove?: (file: string) => void } = {}): SignInPageWatch {
  let done = false;
  let resolveGone: () => void = () => {};
  const gone = new Promise<void>(resolve => { resolveGone = resolve; });
  const removeOnce = options.remove ?? removeSignInPage;
  const remove = (left: number): void => {
    try { removeOnce(file); } catch {
      if (left > 0) { const again = setTimeout(() => remove(left - 1), REMOVE_RETRY_MS); again.unref?.(); }
    }
  };
  const finish = (): void => {
    if (done) return;
    done = true;
    held.delete(finish);
    clearInterval(timer);
    clearTimeout(expiry);
    try { remove(REMOVE_RETRIES); } finally {
      try { options.onEnd?.(); } catch { /* the page is dealt with either way */ }
      resolveGone();
    }
  };
  const timer = setInterval(() => { try { if (spent()) finish(); } catch { finish(); } }, options.everyMs ?? 500);
  const expiry = setTimeout(finish, Math.max(0, (options.expiresAt ?? Date.now() + SIGN_IN_LINK_MS) - Date.now()));
  timer.unref?.();
  expiry.unref?.();
  holdUntilExit(finish);
  return { stop: finish, gone };
}

export type SignInOpen = {
  /** A folder of this user's own the page's folder is made in. */
  parent: string;
  /** Whether the link has been spent (ledgerSpent). */
  spent: () => boolean;
  /** When the link stops working: its mint's deadline (ms since the epoch), read before it was minted. */
  expiresAt: number;
  opener?: SignInOpener;
  platform?: NodeJS.Platform;
  everyMs?: number;
  /** Called once the page is gone (to close what `spent` reads). */
  onEnd?: () => void;
};

export type SignInHandoff = {
  opened: boolean;
  /** Delete the page now. */
  stop: () => void;
  /** Keep this process alive until the link is spent or the page goes, for at most `ms`; then the page goes. For a
   * caller that would otherwise exit before the browser has read the page. */
  wait: (ms: number) => Promise<void>;
};

/**
 * Open `link` in this computer's browser through a page (above). `opened` false: nothing was opened, and nothing is
 * left behind.
 */
export async function openSignInLink(link: string, options: SignInOpen): Promise<SignInHandoff> {
  const platform = options.platform ?? process.platform;
  const nothing: SignInHandoff = { opened: false, stop: () => {}, wait: async () => {} };
  const end = (): void => { try { options.onEnd?.(); } catch { /* nothing to keep */ } };
  if (platformOpener(platform) === null) { end(); return nothing; }
  let file: string;
  try { file = writeSignInPage(options.parent, link); } catch { end(); return nothing; }
  const watch = removeSignInPageWhenSpent(file, options.spent, {
    expiresAt: options.expiresAt,
    ...(options.everyMs === undefined ? {} : { everyMs: options.everyMs }),
    ...(options.onEnd === undefined ? {} : { onEnd: options.onEnd }),
  });
  if (!await openSignInPage(file, options.opener ?? spawnChild, platform)) { watch.stop(); return nothing; }
  const wait = async (ms: number): Promise<void> => {
    // A timer that holds this process open (the watch's own don't), cleared once the page is dealt with.
    let bound: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([watch.gone, new Promise<void>(resolve => { bound = setTimeout(resolve, ms); })]);
    if (bound !== undefined) clearTimeout(bound);
    watch.stop();
  };
  return { opened: true, stop: watch.stop, wait };
}
