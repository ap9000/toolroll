/**
 * The key a per-source budget counts under. One IPv6 subscriber is usually handed a whole /64, so keying by the full
 * address would give one caller 2^64 fresh budgets: a native IPv6 address counts as its /64 (`2001:db8:1:2::/64`),
 * however it is spelled. IPv4 stays exact, and an IPv4-mapped IPv6 address (`::ffff:203.0.113.5`) is that IPv4 address.
 * `::1` stays itself, so this computer is never pooled with anything else. The trusted proxy's `fwd:` marker is kept,
 * and anything that isn't an address ("unknown", a tenant id) is returned unchanged.
 */
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** The eight 16-bit groups of an IPv6 address (brackets and a zone ignored), or null when it isn't one. */
function ipv6Groups(text: string): number[] | null {
  let bare = text.trim().replace(/^\[(.*)\]$/, "$1").replace(/%.*$/, "").toLowerCase();
  if (!bare.includes(":") || !/^[0-9a-f:.]+$/.test(bare)) return null;
  // An embedded IPv4 tail is two groups.
  const tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
  if (tail !== null) {
    if (!IPV4.test(tail[2]!)) return null;
    const [a, b, c, d] = tail[2]!.split(".").map(Number) as [number, number, number, number];
    bare = `${tail[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = bare.split("::");
  if (halves.length > 2) return null;
  const part = (one: string): string[] | null => one === "" ? [] : one.split(":").every(group => /^[0-9a-f]{1,4}$/.test(group)) ? one.split(":") : null;
  const head = part(halves[0]!), rest = halves.length === 2 ? part(halves[1]!) : [];
  if (head === null || rest === null) return null;
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  return [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest].map(group => parseInt(group, 16));
}

/** The budget key for one address, as described above. */
export function sourceKey(source: string): string {
  if (source.startsWith("fwd:")) return `fwd:${sourceKey(source.slice(4))}`;
  if (IPV4.test(source)) return source;
  const groups = ipv6Groups(source);
  if (groups === null) return source;
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) {
    return `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
  }
  if (groups.slice(0, 7).every(group => group === 0) && groups[7] === 1) return "::1";
  return `${groups.slice(0, 4).map(group => group.toString(16)).join(":")}::/64`;
}
