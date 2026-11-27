/**
 * The ways a phone can reach this Mac, as the pairing QR and every `device.hello` carry them (direct first, the hosted
 * relay last). One rule table, used to build the list here and to check it in tests; the phone applies the same rules.
 *
 * - direct: `ws://<private IPv4>:<port>/v1/direct` — a LAN address (10/8, 172.16/12, 192.168/16) or this Mac's
 *   Tailscale address (100.64/10). IP literals only: a name could resolve elsewhere, and iOS lets an app use plain
 *   ws:// to a local IP literal.
 * - hosted: `wss://<relay>/v1/connect` (`ws://` only to this computer, for tests).
 */
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

export interface CompanionPath { kind: "direct" | "hosted"; url: string }

export const MAX_DIRECT_PATHS = 4;
const MAX_URL = 200;

function ipv4Parts(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m === null) return null;
  const parts = m.slice(1).map(Number);
  return parts.every(p => p <= 255) ? parts : null;
}

/** A LAN (RFC 1918) IPv4 address. */
export function isLanIpv4(host: string): boolean {
  const p = ipv4Parts(host);
  if (p === null) return false;
  return p[0] === 10 || (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) || (p[0] === 192 && p[1] === 168);
}

/** A Tailscale (CGNAT 100.64/10) IPv4 address. */
export function isTailnetIpv4(host: string): boolean {
  const p = ipv4Parts(host);
  return p !== null && p[0] === 100 && p[1]! >= 64 && p[1]! <= 127;
}

/** This Mac's LAN IPv4 addresses: up, not internal, private; Wi-Fi/Ethernet (en*) first; at most 3. */
export function lanAddressesOf(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string[] {
  const found: { name: string; address: string }[] = [];
  for (const [name, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      if (info.family === "IPv4" && !info.internal && isLanIpv4(info.address)) found.push({ name, address: info.address });
    }
  }
  found.sort((a, b) => Number(!a.name.startsWith("en")) - Number(!b.name.startsWith("en")) || a.name.localeCompare(b.name));
  return [...new Set(found.map(f => f.address))].slice(0, 3);
}

/** One path's own rules (see the file comment). */
export function pathAllowed(path: CompanionPath): boolean {
  if (typeof path.url !== "string" || path.url.length > MAX_URL) return false;
  let url: URL;
  try { url = new URL(path.url); } catch { return false; }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return false;
  if (path.kind === "direct") {
    return url.protocol === "ws:" && url.port !== "" && url.pathname === "/v1/direct" && (isLanIpv4(url.hostname) || isTailnetIpv4(url.hostname));
  }
  if (path.kind === "hosted") {
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    return url.pathname === "/v1/connect" && (url.protocol === "wss:" || (url.protocol === "ws:" && loopback));
  }
  return false;
}

/** The whole list's rules: 1–5 paths, ≤4 direct, ≤1 hosted and last, no duplicates, each allowed. */
export function pathsAllowed(paths: readonly CompanionPath[]): boolean {
  if (paths.length < 1 || paths.length > MAX_DIRECT_PATHS + 1) return false;
  const direct = paths.filter(p => p.kind === "direct").length, hosted = paths.filter(p => p.kind === "hosted").length;
  if (direct > MAX_DIRECT_PATHS || hosted > 1) return false;
  if (hosted === 1 && paths[paths.length - 1]!.kind !== "hosted") return false;
  if (new Set(paths.map(p => p.url)).size !== paths.length) return false;
  return paths.every(pathAllowed);
}

/** The list for a port, the addresses found and the hosted relay's connect URL (null: no hosted path). */
export function buildPaths(opts: { port: number | null; lan: readonly string[]; tailnet: string | null; hosted: string | null }): CompanionPath[] {
  const direct: CompanionPath[] = [];
  if (opts.port !== null) {
    for (const host of [...opts.lan, ...(opts.tailnet === null ? [] : [opts.tailnet])]) {
      const path: CompanionPath = { kind: "direct", url: `ws://${host}:${opts.port}/v1/direct` };
      if (pathAllowed(path) && !direct.some(d => d.url === path.url)) direct.push(path);
    }
  }
  const out = direct.slice(0, MAX_DIRECT_PATHS);
  if (opts.hosted !== null) {
    const hosted: CompanionPath = { kind: "hosted", url: opts.hosted };
    if (pathAllowed(hosted)) out.push(hosted);
  }
  return out;
}
