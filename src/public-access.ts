/**
 * Serving on a real domain (remote team, phase 3): which requests arrived safely enough to carry an API token,
 * and when the console sends Strict-Transport-Security. Pure rules over what the socket and the one trusted proxy
 * say; serve.ts applies them right after its Host check, and `toolroll serve check-public` probes for them.
 *
 * Trust comes from the socket first. Only a LOOPBACK peer is the documented same-host TLS proxy (Caddy, Cloudflare
 * Tunnel), and only then are X-Forwarded-For (its last hop, via serve.ts's joinSourceOf) and X-Forwarded-Proto
 * believed. Any other peer's forwarded headers are ignored: it reached us over plain HTTP from where it stands.
 */

/** One year, this exact host only: no includeSubDomains, no preload, so sibling names are never pinned. */
export const HSTS_VALUE = "max-age=31536000";

/** What a token-bearing request over plain HTTP from elsewhere is told. */
export const USE_HTTPS =
  "Use HTTPS. API tokens are accepted over plain HTTP only from this computer or your tailnet; connect with the server's https:// address.";

/** IPv4 dotted quad from an IPv4 or IPv4-mapped IPv6 address, else null. */
function ipv4Of(address: string): number[] | null {
  const bare = address.replace(/^::ffff:/i, "");
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (match === null) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(part => part <= 255) ? parts : null;
}

/** Strips brackets and an IPv6 zone so `[::1]` and `fe80::1%en0` compare as addresses. */
const bareAddress = (address: string): string => address.trim().replace(/^\[(.*)\]$/, "$1").replace(/%.*$/, "").toLowerCase();

/**
 * The exact loopback peers serve.ts trusts as the same-host proxy (joinSourceOf, fromThisComputer). Not all of
 * 127/8: a proxy listening on 127.0.0.2 must not make public callers look like this computer.
 */
export const LOOPBACK_PEERS: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** One of LOOPBACK_PEERS (brackets, an IPv6 zone and case ignored). The only loopback test that grants trust. */
export function isLoopbackPeer(address: string): boolean {
  return LOOPBACK_PEERS.has(bareAddress(address));
}

/** 127.0.0.0/8, ::1 and their IPv4-mapped forms. For naming hosts only (public-check.ts); trust uses isLoopbackPeer. */
export function isLoopbackAddress(address: string): boolean {
  const bare = bareAddress(address);
  const v4 = ipv4Of(bare);
  if (v4 !== null) return v4[0] === 127;
  return bare === "::1" || bare === "0:0:0:0:0:0:0:1";
}

/** Tailscale's ranges: 100.64.0.0/10 (and its IPv4-mapped form) and fd7a:115c:a1e0::/48. */
export function isTailnetAddress(address: string): boolean {
  const bare = bareAddress(address);
  const v4 = ipv4Of(bare);
  if (v4 !== null) return v4[0] === 100 && v4[1]! >= 64 && v4[1]! <= 127;
  return /^fd7a:115c:a1e0(:|$)/.test(bare);
}

/** How one request reached the server, as far as it can be proved. */
export type Transport = {
  /** The caller's address: the socket peer, or the trusted proxy's last X-Forwarded-For hop. */
  source: string;
  /** Proved to have arrived over HTTPS at a same-host proxy. */
  https: boolean;
  /** The caller is this computer or a tailnet address (WireGuard already encrypts it). */
  privatePath: boolean;
};

/** The last value of a possibly repeated, comma-separated header (the one the trusted proxy itself set). */
const lastValue = (header: string | string[] | undefined): string => {
  const joined = Array.isArray(header) ? header.join(",") : header ?? "";
  return joined.split(",").pop()?.trim().toLowerCase() ?? "";
};

/**
 * The request's transport from its socket peer, the source serve.ts's joinSourceOf derived (`fwd:<hop>` only for a
 * loopback peer) and the proxy headers. A loopback peer that forwards with `Forwarded` but no X-Forwarded-For names
 * no caller we can read, so it is not treated as this computer.
 */
export function transportOf(request: {
  peer: string | undefined;
  joinSource: string;
  forwardedProto: string | string[] | undefined;
  forwarded: string | string[] | undefined;
}): Transport {
  const peer = request.peer ?? "";
  if (!isLoopbackPeer(peer)) {
    return { source: peer, https: false, privatePath: isTailnetAddress(peer) };
  }
  const relayed = request.joinSource.startsWith("fwd:");
  const source = relayed ? request.joinSource.slice(4) : peer;
  const https = lastValue(request.forwardedProto) === "https";
  if (!relayed && request.forwarded !== undefined) return { source: "unknown", https, privatePath: false };
  return { source, https, privatePath: isLoopbackPeer(source) || isTailnetAddress(source) };
}

/** The OAuth endpoints that hand out, consent to or take back a token (mcp-oauth.ts; revoke is reserved). Discovery stays public. */
export const OAUTH_TOKEN_PATHS: ReadonlySet<string> = new Set(["/oauth/authorize", "/oauth/token", "/oauth/register", "/oauth/revoke"]);

/** Requests that carry, or exist to carry, an API token: the remote CLI, the MCP gateway, MCP sign-in, and any bearer credential. */
export function carriesToken(pathname: string, authorization: string | undefined): boolean {
  if (pathname === "/api/cli" || pathname.startsWith("/api/cli/") || pathname === "/mcp" || pathname.startsWith("/mcp/")) return true;
  if (OAUTH_TOKEN_PATHS.has(pathname.replace(/\/+$/, "") || "/")) return true;
  return authorization !== undefined && /^bearer\s/i.test(authorization);
}

/** The refusal for a token sent over plain HTTP from outside this computer and the tailnet, else null. */
export function plainHttpRefusal(transport: Transport, pathname: string, authorization: string | undefined): string | null {
  if (transport.https || transport.privatePath) return null;
  return carriesToken(pathname, authorization) ? USE_HTTPS : null;
}

/** The Strict-Transport-Security value for a request to the configured public https host that arrived over HTTPS. */
export function hstsFor(publicHost: string | null, host: string | undefined, transport: Transport): string | null {
  return publicHost !== null && host === publicHost && transport.https ? HSTS_VALUE : null;
}
