/**
 * Flexible threads, the console's launcher (pre-enable: the solo-workbench plan's thread start; the Flexible plan v2 §2,
 * Codex round 2 items 3 and 10): how a thread's turn gets its network and its storage check in this console. The thread
 * engine (flexible-agents.ts startFlexibleTurn) takes both as inputs; the thread's session (flexible-session.ts) asks
 * this launcher for them, once per turn that may launch an agent.
 *
 * The rules this module keeps:
 * - Nothing here works while FLEXIBLE_AVAILABLE is false: every entry point refuses with `not-available` first, and the
 *   console makes no launcher then.
 * - A thread's network is the project's own, read from Toolroll's records (store.projectNetwork) at each launch, never
 *   from a checkout or a request, and always through a run proxy of the launch's own (the thread fence admits that proxy
 *   and nothing else, flexible-thread.ts). Confined: the project's hosts and its ecosystems' package registries, and no
 *   provider host (the agent's model calls go through its sign-in relay, never the proxy). Open: any host by name, still
 *   only through the proxy (public addresses, ports 443 and 80, this launch's credentials). Local services are never
 *   reachable, whatever the project's loopback setting says.
 * - The proxy lives exactly as long as the launch: startFlexibleTurn closes it the moment its agent is stopped (or at
 *   once when the turn doesn't launch), the holder's watcher closes it when a stop happened elsewhere, and closing the
 *   launcher (the console stopping) closes every proxy still open. Closing twice is harmless.
 * - The storage check (protected-storage.ts) is each launch's own and finishes before the launch: no earlier walk stands
 *   in for it. A check that can't finish refuses the turn in its own words.
 * - A first launch can be held to the network a person was shown (`expect`: the terms card's network digest,
 *   flexible-start.ts): a project setting changed in between refuses the start rather than launch under a network
 *   nobody agreed to.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { FLEXIBLE_AVAILABLE } from "./flexible-available.js";
import { FLEXIBLE_UNAVAILABLE } from "./flexible.js";
import { NETWORK_POLICY_VERSION, proxyEnv, REGISTRY_HOSTS, repositoryEcosystems, startEgressProxy, type EgressProxy, type NetworkProfile } from "./egress.js";
import { prepareProtectedStorage, storageRefusalOf, type ProtectedStorage } from "./protected-storage.js";
import type { Store } from "./store.js";

/** One launch's network, as the thread engine takes it: its proxy's port and credential, the variables that point the
 * agent at it, and how to close it. */
export type FlexibleLaunchNetwork = { proxyPort: number; token: string; proxyEnv: Record<string, string>; close: () => void | Promise<void> };

export type FlexibleLauncherRefusal = { ok: false; reason: "not-available" | "network-changed" | "storage" | "no-network"; message: string };
const WORDS = Object.freeze({
  "not-available": FLEXIBLE_UNAVAILABLE,
  "network-changed": "This project's network setting changed since the terms were shown. Look at them again before starting. Nothing was started.",
  "storage": "Toolroll couldn't finish checking other apps' data for links to keep out of the thread, so nothing was started.",
  "no-network": "The thread's network proxy couldn't be started, so nothing was started.",
} as const);
const refuse = (reason: FlexibleLauncherRefusal["reason"], message: string = WORDS[reason]): FlexibleLauncherRefusal => ({ ok: false, reason, message });

/** How a turn's agent gets its network and storage in this console (createFlexibleLauncher). */
export type FlexibleLauncher = {
  /** For one launch of `thread` (its id and its project, from the thread's own record): the storage check, then the
   * launch's own proxy under the project's network now (held to `expect.network` when given). */
  prepare: (thread: { id: string; repo: string }, expect?: { network: string }) => Promise<{ ok: true; network: FlexibleLaunchNetwork; storage: ProtectedStorage } | FlexibleLauncherRefusal>;
  /** The platform the agent launches on (default: this one). */
  platform?: NodeJS.Platform;
  /** Every proxy this launcher started and nobody closed yet. */
  open: () => number;
  /** Close every proxy still open (the console stopping); throws while any couldn't be (each stays listed for a retry). */
  close: () => Promise<void>;
};

/**
 * A thread's network in `repo` now, from Toolroll's records: the project's setting (store.projectNetwork), its
 * repository's package registries when confined, never a provider's own host, never local services.
 */
export function flexibleThreadNetwork(store: Pick<Store, "projectNetwork">, repo: string): NetworkProfile | FlexibleLauncherRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  const project = store.projectNetwork(repo);
  if (project.mode === "open") return { version: NETWORK_POLICY_VERSION, mode: "open", hosts: [], loopback: "proxy-only" };
  const hosts = new Set<string>([...repositoryEcosystems(repo).flatMap(one => REGISTRY_HOSTS[one]), ...project.hosts]);
  return { version: NETWORK_POLICY_VERSION, mode: "allowlist", hosts: [...hosts].sort(), loopback: "proxy-only" };
}

/** A digest of exactly a thread's network (its mode and hosts), domain-separated: what a terms card binds. */
export function flexibleNetworkDigest(network: NetworkProfile): string {
  return createHash("sha256").update(`standing-orders:flexible-network:${JSON.stringify({ mode: network.mode, hosts: network.hosts, loopback: network.loopback })}`, "utf8").digest("hex").slice(0, 32);
}

/** Seams (parameters, never settings): the proxy and the storage check, so a test can count what was started and closed
 * without a real network or a walk of the person's home. */
export type FlexibleLauncherSeams = {
  startProxy?: (options: { hosts: readonly string[]; open?: true }) => Promise<EgressProxy>;
  storage?: () => Promise<ProtectedStorage>;
  platform?: NodeJS.Platform;
};

/** The console's launcher (engine-api.ts makes one beside its thread host); refused while Flexible isn't available. */
export function createFlexibleLauncher(store: Pick<Store, "projectNetwork">, seams: FlexibleLauncherSeams = {}): FlexibleLauncher | FlexibleLauncherRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  const startProxy = seams.startProxy ?? ((options: { hosts: readonly string[]; open?: true }) => startEgressProxy(options));
  const storageNow = seams.storage ?? (() => prepareProtectedStorage(homedir()));
  // Each open proxy and its one closing (shared by the launch's own close and the launcher's): closed once, however asked.
  const live = new Map<EgressProxy, () => Promise<void>>();
  let closed = false;
  // A close that fails keeps the proxy listed (open() counts it) and its closer ready to try again: revokeLaunch and the
  // holder's watcher retry a closer that throws, and the launcher's own close retries every one still listed.
  const closerOf = (proxy: EgressProxy): (() => Promise<void>) => {
    let closing: Promise<void> | null = null;
    return () => {
      closing ??= (async () => {
        try { await proxy.close(); live.delete(proxy); } catch (error) { closing = null; throw error; }
      })();
      return closing;
    };
  };
  return {
    ...(seams.platform === undefined ? {} : { platform: seams.platform }),
    open: () => live.size,
    async prepare(thread, expect) {
      if (closed) return refuse("no-network");
      const network = flexibleThreadNetwork(store, thread.repo);
      if ("ok" in network) return network;
      if (expect !== undefined && flexibleNetworkDigest(network) !== expect.network) return refuse("network-changed");
      // The storage check first: when it refuses, no proxy was started that would need closing.
      let storage: ProtectedStorage;
      try { storage = await storageNow(); } catch (error) {
        const words = storageRefusalOf(error)?.message;
        return refuse("storage", words ?? WORDS.storage);
      }
      let proxy: EgressProxy;
      try { proxy = await startProxy(network.mode === "open" ? { hosts: [], open: true } : { hosts: network.hosts }); } catch { return refuse("no-network"); }
      if (closed) { await proxy.close(); return refuse("no-network"); }
      const close = closerOf(proxy);
      live.set(proxy, close);
      return { ok: true, storage, network: { proxyPort: proxy.port, token: proxy.secret, proxyEnv: proxyEnv(proxy, "proxy-only"), close } };
    },
    async close() {
      closed = true;
      await Promise.allSettled([...live.values()].map(close => close()));
      if (live.size > 0) throw new Error(`${live.size} of the threads' network proxies couldn't be closed yet`);
    },
  };
}
