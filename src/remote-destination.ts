/**
 * Where a read of a recorded remote really connects, worked out and pinned before git runs (docs/plans/code-map.md §1).
 * remote-main.ts's URL rules look at a host's spelling; a name can still resolve to this machine. Here the name is
 * resolved once, every address is checked, and git is told to use exactly the checked address. Routing is decided from
 * the same environment git gets. Anything that can't be decided or pinned refuses with a reason: there is no fallback to
 * an unpinned read.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export type Lookup = (host: string) => Promise<readonly string[]>;
export const lookupAll: Lookup = async host => (await dnsLookup(host, { all: true, verbatim: true })).map(one => one.address);

export type Destination = { scheme: "https" | "ssh"; host: string; port: number; literal: boolean };
export type Pin = {
  /** `-c` settings for git, or nothing for ssh. */
  gitArgs: string[];
  /** Environment on top of remote-main.ts's ENV. */
  env: Record<string, string>;
  /** The proxy's host name when the read goes through the operator's proxy. */
  proxy: string | null;
};
export type PinResult = { ok: true; pin: Pin } | { ok: false; why: string };

const UNDECIDED = "Toolroll can't tell how this connection would be routed";
const NOT_ALLOWED = "its address isn't one Toolroll connects to";

/** The eight 16-bit groups of an IPv6 address; null when it isn't one. */
function hextets(address: string): number[] | null {
  let text = address.toLowerCase().replace(/%.*$/, "");
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted !== null) {
    const parts = dotted[1]!.split(".").map(Number);
    if (parts.some(part => part > 255)) return null;
    text = `${text.slice(0, dotted.index)}${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] === "" ? [] : halves[0]!.split(":");
  const right = halves.length === 1 || halves[1] === "" ? [] : halves[1]!.split(":");
  const gap = 8 - left.length - right.length;
  if (halves.length === 1 ? gap !== 0 : gap < 1) return null;
  const groups = [...left, ...Array<string>(halves.length === 1 ? 0 : gap).fill("0"), ...right].map(one => parseInt(one, 16));
  return groups.length === 8 && groups.every(one => Number.isInteger(one) && one >= 0 && one <= 0xffff) ? groups : null;
}

const refusedV4 = (address: string): boolean => {
  const [a, b] = address.split(".").map(Number) as [number, number];
  return a === 127 || a === 0 || (a === 169 && b === 254);
};
const v4Of = (high: number, low: number): string => `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;

/** Whether an address is loopback, unspecified, link-local, or an IPv4-mapped or NAT64 form of these. */
export function addressRefused(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return refusedV4(address);
  if (family !== 6) return true;
  const g = hextets(address);
  if (g === null) return true;
  const top = g.slice(0, 5).every(one => one === 0);
  if (top && g[5] === 0 && g[6] === 0 && (g[7] === 0 || g[7] === 1)) return true; // :: and ::1
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10
  if (top && g[5] === 0xffff) return refusedV4(v4Of(g[6]!, g[7]!)); // ::ffff:a.b.c.d
  if (top && g[5] === 0) return refusedV4(v4Of(g[6]!, g[7]!)); // ::a.b.c.d (deprecated compatible form)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(one => one === 0)) return refusedV4(v4Of(g[6]!, g[7]!)); // 64:ff9b::/96
  return false;
}

/** The host, effective port and scheme a recorded URL connects to; null when it can't be read. The caller has already
 * passed remoteUrlProblem. Node's URL parser normalizes every spelling of a literal host. */
export function destinationOf(url: string): Destination | null {
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url)?.[1]?.toLowerCase();
  let host: string, port: number;
  if (scheme === "https" || scheme === "ssh") {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return null; }
    host = parsed.hostname.replace(/^\[(.*)\]$/, "$1");
    port = parsed.port === "" ? (scheme === "https" ? 443 : 22) : Number(parsed.port);
    return validDestination(scheme, host, port);
  }
  if (scheme !== undefined) return null;
  const colon = url.indexOf(":");
  if (colon <= 0) return null;
  host = url.slice(0, colon).replace(/^.*@/, "");
  return validDestination("ssh", host, 22);
}
function validDestination(scheme: "https" | "ssh", host: string, port: number): Destination | null {
  const literal = isIP(host) !== 0;
  if (!literal && !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.?$/.test(host)) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { scheme, host, port, literal };
}

type Checked = { ok: true; address: string } | { ok: false; why: string };
async function checkedAddress(host: string, literal: boolean, lookup: Lookup): Promise<Checked> {
  if (literal) return addressRefused(host) ? { ok: false, why: NOT_ALLOWED } : { ok: true, address: host };
  let found: readonly string[];
  try { found = await lookup(host); } catch { return { ok: false, why: "its host name couldn't be resolved" }; }
  if (found.length === 0) return { ok: false, why: "its host name couldn't be resolved" };
  // Every address, not just the first: a name that also answers with this machine isn't connected to.
  if (found.some(addressRefused)) return { ok: false, why: NOT_ALLOWED };
  return { ok: true, address: found[0]! };
}

const curlPin = (host: string, port: number, address: string): string[] =>
  ["-c", `http.curloptResolve=${host}:${port}:${isIP(address) === 6 ? `[${address}]` : address}`];

/** One NO_PROXY entry against a host, as curl compares them; "unknown" for anything Toolroll won't second-guess. */
function noProxyMatch(entry: string, host: string): boolean | "unknown" {
  const raw = entry.replace(/^\[(.*)\]$/, "$1");
  if (raw === "*") return true;
  const hostIp = isIP(host);
  const cidr = /^(.+)\/(\d+)$/.exec(raw);
  if (cidr !== null) {
    if (isIP(cidr[1]!) === 0) return "unknown";
    if (hostIp === 0) return false;
    if (hostIp !== isIP(cidr[1]!)) return false;
    const bits = Number(cidr[2]);
    if (hostIp === 4) {
      if (bits > 32) return "unknown";
      const value = (ip: string) => ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);
      const size = 2 ** (32 - bits);
      return Math.floor(value(host) / size) === Math.floor(value(cidr[1]!) / size);
    }
    return "unknown";
  }
  if (isIP(raw) !== 0) return hostIp !== 0 && (hextets(raw)?.join() ?? raw) === (hextets(host)?.join() ?? host);
  if (/[^A-Za-z0-9.-]/.test(raw)) return "unknown";
  if (hostIp !== 0) return false;
  const name = raw.replace(/^\.+/, "").replace(/\.+$/, "").toLowerCase();
  const wanted = host.replace(/\.+$/, "").toLowerCase();
  return name !== "" && (wanted === name || wanted.endsWith(`.${name}`));
}

/** Whether curl would skip the proxy for this host; "unknown" when an entry can't be decided. */
export function noProxyApplies(noProxy: string, host: string): boolean | "unknown" {
  let unknown = false;
  for (const entry of noProxy.split(/[,\s]+/).filter(Boolean)) {
    const hit = noProxyMatch(entry, host);
    if (hit === true) return true;
    if (hit === "unknown") unknown = true;
  }
  return unknown ? "unknown" : false;
}

const envOf = (env: Readonly<Record<string, string | undefined>>, lower: string, upper: string): string => {
  const low = env[lower];
  return low !== undefined && low !== "" ? low : env[upper] ?? "";
};

/** The proxy curl would use from `https_proxy`/`HTTPS_PROXY`: http or https schemes only (a SOCKS proxy resolves names
 * on its side, in ways this can't see). */
function proxyOf(value: string): { host: string; port: number; literal: boolean } | null {
  const text = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) ? value : `http://${value}`;
  let parsed: URL;
  try { parsed = new URL(text); } catch { return null; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1");
  const port = parsed.port === "" ? (parsed.protocol === "https:" ? 443 : 1080) : Number(parsed.port);
  const literal = isIP(host) !== 0;
  if (host === "" || (!literal && !/^[A-Za-z0-9.-]+$/.test(host))) return null;
  return { host, port, literal };
}

/**
 * Decide the route and pin it. `env` is what git will see (the names remote-main.ts's ENV_ALLOWLIST passes). ssh never
 * uses a proxy. Through a proxy, the proxy's own address is checked and pinned; the operator's proxy then chooses the
 * final destination, and the caller says so.
 */
export async function pinDestination(url: string, env: Readonly<Record<string, string | undefined>>, lookup: Lookup = lookupAll): Promise<PinResult> {
  const target = destinationOf(url);
  if (target === null) return { ok: false, why: UNDECIDED };
  if (target.scheme === "ssh") {
    const checked = await checkedAddress(target.host, target.literal, lookup);
    if (!checked.ok) return checked;
    return { ok: true, pin: { gitArgs: [], proxy: null, env: { GIT_SSH_COMMAND:
      `ssh -o BatchMode=yes -o ProxyCommand=none -o ProxyJump=none -o HostName=${checked.address} -o Port=${target.port} -o HostKeyAlias=${target.host} -o CheckHostIP=no` } } };
  }
  const proxyValue = envOf(env, "https_proxy", "HTTPS_PROXY");
  if (proxyValue !== "") {
    const skip = noProxyApplies(envOf(env, "no_proxy", "NO_PROXY"), target.host);
    if (skip === "unknown") return { ok: false, why: UNDECIDED };
    if (!skip) {
      const proxy = proxyOf(proxyValue);
      if (proxy === null) return { ok: false, why: UNDECIDED };
      const checked = await checkedAddress(proxy.host, proxy.literal, lookup);
      if (!checked.ok) return { ok: false, why: `your proxy's ${checked.why.replace(/^its /, "")}` };
      return { ok: true, pin: { gitArgs: curlPin(proxy.host, proxy.port, checked.address), env: {}, proxy: proxy.host } };
    }
  }
  const checked = await checkedAddress(target.host, target.literal, lookup);
  if (!checked.ok) return checked;
  return { ok: true, pin: { gitArgs: curlPin(target.host, target.port, checked.address), env: {}, proxy: null } };
}
