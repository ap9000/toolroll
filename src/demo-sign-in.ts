/**
 * Eight W2: `toolroll demo` opens the browser already signed in, through the console's own one-time sign-in link
 * (serve.ts mintSignInLink: single use, ten minutes, only a hash kept in memory, redeemed only by a browser on this
 * computer with no proxy in between, never written to a log).
 *
 * Who gets a link, and where it points, are decided here and nowhere else:
 * - only a person at the demo's own terminal (stdin AND stdout a TTY, not under a coding agent, no --json): anything
 *   else gets today's greeting with no link — nothing is minted, printed or opened;
 * - only for the sandbox's fixed demo account (the password-backed one seedDemo creates), never a local-owner link;
 * - only on a loopback origin built from the address the demo's server ACTUALLY bound (127.0.0.1 or ::1; `localhost`
 *   binds one of them) and its bound port — never from --allow-host, a Host header, a redirect or any other input. A
 *   wildcard (0.0.0.0, ::), LAN or tailnet bind gets no link at all.
 */
import { spawn as spawnChild, type SpawnOptions } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { SIGN_IN_LINK_MS, SIGN_IN_LINK_PATH } from "./server/session.js";
import type { Store } from "./store.js";

/** Whether the demo was started by a person at its own terminal. */
export type DemoCaller = { stdin: boolean; stdout: boolean; agent: boolean; json: boolean };

/** The loopback origin a sign-in link may carry: the server's bound address when it is loopback, else null. */
export function demoLoopbackOrigin(address: AddressInfo | string | null): string | null {
  if (address === null || typeof address === "string") return null;
  if (!Number.isInteger(address.port) || address.port < 1 || address.port > 65_535) return null;
  if (address.address === "127.0.0.1") return `http://127.0.0.1:${address.port}`;
  if (address.address === "::1") return `http://[::1]:${address.port}`;
  return null;
}

/**
 * The demo's one-time sign-in address for its fixed account, or null (no person at the terminal, no loopback origin,
 * or the account can't have a link). The guard and the origin are proved before anything is minted.
 */
export function demoSignInLink(
  server: { mintSignInLink(account: string): string | null; address(): AddressInfo | string | null },
  account: string,
  caller: DemoCaller,
): string | null {
  if (!caller.stdin || !caller.stdout || caller.agent || caller.json) return null;
  const origin = demoLoopbackOrigin(server.address());
  if (origin === null) return null;
  const path = server.mintSignInLink(account);
  if (path === null || !path.startsWith(SIGN_IN_LINK_PATH)) return null;
  return `${origin}${path}`;
}

/** A page only this user can read that moves the browser on to `link`: its path, in a fresh 0700 folder under `parent`. */
export function writeSignInPage(parent: string, link: string): string {
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

/**
 * Open a sign-in page with the platform's own opener only: `open` on macOS, `xdg-open` on Linux, with the page's path as
 * its one argument. No override (TOOLROLL_BROWSER_COMMAND or any other) is honoured. False where there is none.
 */
export function openSignInPage(file: string, spawn: (command: string, args: string[], options: SpawnOptions) => { unref(): void } = spawnChild, platform: NodeJS.Platform = process.platform): boolean {
  const command = platform === "darwin" ? "open" : platform === "linux" ? "xdg-open" : null;
  if (command === null) return false;
  try { spawn(command, [file], { detached: true, stdio: "ignore" }).unref(); return true; } catch { return false; }
}

/**
 * Delete the page once its link is spent (the console's ledger records the one-time sign-in for this account), and at
 * the latest when the link expires. Returns a stop that deletes it now (the demo stopping).
 */
export function removeSignInPageWhenSpent(store: Store, file: string, account: string, options: { everyMs?: number; expiresMs?: number } = {}): () => void {
  const sinceRow = store.handle.prepare("SELECT coalesce(max(id), 0) AS id FROM action_ledger").get();
  const since = Number(sinceRow?.["id"] ?? 0);
  const spent = store.handle.prepare("SELECT 1 FROM action_ledger WHERE id > ? AND source = 'sign-in' AND actor = ? AND action = 'signed in' AND outcome = 'one-time link' LIMIT 1");
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    clearInterval(timer);
    clearTimeout(expiry);
    removeSignInPage(file);
  };
  const timer = setInterval(() => { try { if (spent.get(since, account) !== undefined) finish(); } catch { finish(); } }, options.everyMs ?? 500);
  const expiry = setTimeout(finish, options.expiresMs ?? SIGN_IN_LINK_MS);
  timer.unref?.();
  expiry.unref?.();
  return finish;
}
