/**
 * Check access (v132, docs/plans/check-access.md): how far a project's setup and check commands reach beyond the
 * plane's check fence. `sandboxed` (the default) is the fence as it is; `sign-ins` also reads the exact sign-in files
 * of Claude, Codex and gh, under the project's network fence; `unsandboxed` runs them with no OS fence, trusted by the
 * whole instance, for a project whose checks must create sandboxes themselves (Toolroll's own). Widening is an instance
 * operator's act with a password typed now; any approver for the project may narrow it back.
 */

import { PROVIDER_HOSTS, type NetworkProfile, type ProjectNetwork } from "./egress.js";

export const CHECK_ACCESS_LEVELS = ["sandboxed", "sign-ins", "unsandboxed"] as const;
export type CheckAccess = typeof CHECK_ACCESS_LEVELS[number];
export const CHECK_ACCESS_DEFAULT: CheckAccess = "sandboxed";

export const isCheckAccess = (value: unknown): value is CheckAccess => typeof value === "string" && (CHECK_ACCESS_LEVELS as readonly string[]).includes(value);

/** A stored or sealed value as a level: anything missing or unreadable is the narrowest, never a wider one. */
export const checkAccessOf = (value: unknown): CheckAccess => isCheckAccess(value) ? value : CHECK_ACCESS_DEFAULT;

const RANK: Readonly<Record<CheckAccess, number>> = { sandboxed: 0, "sign-ins": 1, unsandboxed: 2 };
export const widerThan = (a: CheckAccess, b: CheckAccess): boolean => RANK[a] > RANK[b];
/** The narrowest of several levels (none given: the default). */
export const narrowestAccess = (levels: readonly CheckAccess[]): CheckAccess =>
  levels.reduce<CheckAccess>((low, one) => RANK[one] < RANK[low] ? one : low, levels.length === 0 ? CHECK_ACCESS_DEFAULT : "unsandboxed");

/** The level as a person reads it, in a sentence's middle ("Checks: …"). */
export function checkAccessWords(level: CheckAccess): string {
  return level === "sandboxed" ? "sandboxed" : level === "sign-ins" ? "sandboxed, with model and GitHub sign-ins" : "not sandboxed";
}

/** What each wider level means, said before anyone chooses it. */
export const CHECK_ACCESS_WARNINGS: Readonly<Record<Exclude<CheckAccess, "sandboxed">, string>> = {
  "sign-ins": "This project's checks can read your Claude, Codex and GitHub sign-ins. Its tests could use or send those credentials anywhere its network setting allows. Only choose this for projects you trust.",
  unsandboxed: "This project's checks get your full access to this machine and to Toolroll itself, including its database and every sign-in. Only for a project whose checks must create sandboxes themselves, such as Toolroll's own.",
};

/** The services whose sign-ins a `sign-ins` check reads: Claude's and Codex's own hosts (egress.ts), and GitHub's. */
export const SIGN_IN_HOSTS: readonly string[] = [...PROVIDER_HOSTS["claude"]!, ...PROVIDER_HOSTS["codex"]!, "github.com", "api.github.com"];

/** Which of those a project's network doesn't allow (an open network allows all). The check's network is never widened
 * for them: the operator adds them, as a network change of its own. */
export function signInHostsMissing(network: ProjectNetwork): string[] {
  if (network.mode === "open") return [];
  const covered = (host: string) => network.hosts.some(one => one === host || (one.startsWith("*.") && host.endsWith(one.slice(1))));
  return SIGN_IN_HOSTS.filter(host => !covered(host));
}

/** The narrower of two networks: every host both allow (a wildcard allows what it covers), local services only if both
 * do, open only if both are. A check never reaches what either its sealed network or the project's current one refuses. */
export function narrowestNetwork(a: NetworkProfile, b: NetworkProfile): NetworkProfile {
  const loopback = a.loopback === "any" && b.loopback === "any" ? "any" : "proxy-only";
  if (a.mode === "open" && b.mode === "open") return { version: 1, mode: "open", hosts: [], loopback };
  if (a.mode === "open") return { ...b, loopback };
  if (b.mode === "open") return { ...a, loopback };
  const covers = (list: readonly string[], host: string) => list.some(one => one === host || (one.startsWith("*.") && (host.endsWith(one.slice(1)) || host === one)));
  const hosts = [...new Set([...a.hosts.filter(host => covers(b.hosts, host)), ...b.hosts.filter(host => covers(a.hosts, host))])].sort();
  return { version: 1, mode: "allowlist", hosts, loopback };
}

/** A build's checks' own network: what its approval sealed, less its agent's provider hosts (those are the agent's, never
 * its checks'); narrower if a project host happens to be one of them. */
export function checkNetworkOf(sealed: NetworkProfile, provider: string, project: ProjectNetwork): NetworkProfile {
  if (sealed.mode === "open") return sealed;
  // A provider host the project itself lists (an operator added it, for its sign-ins, say) is the checks' too.
  const agent = new Set((PROVIDER_HOSTS[provider] ?? []).filter(host => !project.hosts.includes(host)));
  return { ...sealed, hosts: sealed.hosts.filter(host => !agent.has(host)) };
}

/** Off everywhere, for now (0.9.69): no `sign-ins`. Reading a sign-in file resolves its parent folders by path (Node
 * has no openat), and each review round found another way a build or a check could swap a folder on that path between
 * the checks and the read (on Linux a Claude build can write ~/.claude outright). Until that read is race-free, no
 * check gets sign-ins: setting the level is refused, a level saved or sealed before (or copied in from another
 * database) runs sandboxed, a scope seals sandboxed, and the sign-ins launch refuses first thing. The code behind it
 * (signInGrants, readGrantedFile, the copies, the network fence) stays, guarded, for when such a reader exists; flip
 * SIGN_INS_READY then (Linux stays off until its copies are race-free too). */
export const SIGN_INS_READY = false;
export const signInsAvailable = (platform: NodeJS.Platform = process.platform): boolean => SIGN_INS_READY && platform !== "linux";

/** Why sign-ins can't be chosen here, said plainly (null: they can). */
export const signInsUnavailableWords = (platform: NodeJS.Platform = process.platform): string | null => signInsAvailable(platform) ? null
  : "Not available yet: sign-ins can't be shared with checks safely. Choose Sandboxed or Not sandboxed.";

/** The level checks actually get on this platform: `sign-ins` where it isn't available is `sandboxed` (narrower, never
 * wider). Everything that seals, launches or stamps a check's level goes through this. */
export const checkAccessHere = (level: CheckAccess, platform: NodeJS.Platform = process.platform): CheckAccess =>
  level === "sign-ins" && !signInsAvailable(platform) ? CHECK_ACCESS_DEFAULT : level;

/** How a project's checks actually run here, as the settings page and `project check-access` say it: with no OS fence
 * on this machine and unconfined running allowed by an operator, without a sandbox whatever is saved (never said to be
 * sandboxed); otherwise the saved level as this platform can give it. */
export function checkAccessRunsAs(level: CheckAccess, here: { platform: NodeJS.Platform; fenced: boolean; unconfinedAllowed: boolean }): CheckAccess {
  return !here.fenced && here.unconfinedAllowed ? "unsandboxed" : checkAccessHere(level, here.platform);
}
