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
import type { AddressInfo } from "node:net";
import { SIGN_IN_LINK_PATH } from "./server/session.js";

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
