/**
 * An agent's request to change a project's network (`project network --request`), approved by a person.
 *
 * The request file (agent-requests.ts) is unauthenticated, editable JSON: anything in it, its summary included, is an
 * untrusted proposal. What a person approves is computed here, by the server, from exactly three things the file may
 * propose — the project, the kind, and an explicit change (hosts to add, hosts to remove, and only when asked for, the
 * mode and local services) — applied to the project's CURRENT setting. Never a full next state captured when the request
 * was filed: a host removed since stays removed unless the request names it to add. The page shows these exact terms
 * with a digest of the current setting and the change; the approval sends that digest back, and the write (re-derived in
 * the same transaction) is refused when the setting or the request no longer matches what was shown.
 */
import { createHash } from "node:crypto";
import { listAgentRequests, resolveAgentRequest, type AgentRequest } from "./agent-requests.js";
import { canonicalJson } from "./canonical-json.js";
import { MAX_NETWORK_HOSTS, normalizeHost, type ProjectNetwork } from "./egress.js";
import { proposeNetworkChanges } from "./route-change.js";
import type { Store } from "./store.js";

/** The explicit change a network request proposes: null mode or local leaves that part as it is now. */
export type NetworkChange = { add: string[]; remove: string[]; mode: "open" | "allowlist" | null; local: "any" | "proxy-only" | null };

/** The exact terms a person approves: computed from the current setting, never read from the request file. */
export type NetworkRequestTerms = {
  id: string;
  repo: string;
  requester: string;
  why: string;
  change: NetworkChange;
  before: ProjectNetwork;
  after: ProjectNetwork;
  /** sha256 (32 hex) over the request id, project, change, and the setting before and after. */
  digest: string;
  /** What changes, in the server's own words (never the request's summary). */
  words: string[];
};

export const NETWORK_REQUEST_OLD = "This request was made by an older version of Toolroll. Ask the agent to request it again.";
export const NETWORK_REQUEST_CHANGED = "This request or the project's network changed since you looked. Nothing changed; review it again.";

const hostList = (value: unknown): string[] | null => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_NETWORK_HOSTS) return null;
  const hosts: string[] = [];
  for (const one of value) {
    if (typeof one !== "string") return null;
    const host = normalizeHost(one);
    if (host === null) return null;
    hosts.push(host);
  }
  return [...new Set(hosts)].sort();
};

/** The change a request proposes, read strictly; null when it names none or anything in it is malformed. */
export function readNetworkChange(params: unknown): NetworkChange | null {
  if (params === null || typeof params !== "object") return null;
  const change = (params as { change?: unknown }).change;
  if (change === null || typeof change !== "object" || Array.isArray(change)) return null;
  const { add, remove, mode, local, ...rest } = change as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return null;
  const adds = hostList(add), removes = hostList(remove);
  if (adds === null || removes === null || adds.some(one => removes.includes(one))) return null;
  if (mode !== undefined && mode !== null && mode !== "open" && mode !== "allowlist") return null;
  if (local !== undefined && local !== null && local !== "any" && local !== "proxy-only") return null;
  return { add: adds, remove: removes, mode: (mode as NetworkChange["mode"] | undefined) ?? null, local: (local as NetworkChange["local"] | undefined) ?? null };
}

function changeWords(change: NetworkChange, after: ProjectNetwork): string[] {
  const words: string[] = [];
  if (change.mode === "open") words.push("Let builds reach any host");
  if (change.mode === "allowlist") words.push("Limit builds to the listed hosts");
  if (change.add.length > 0) words.push(`Allow ${change.add.join(", ")}`);
  if (change.remove.length > 0) words.push(`Stop allowing ${change.remove.join(", ")}`);
  if (change.local === "any") words.push("Let builds reach this Mac's local services");
  if (change.local === "proxy-only") words.push("Stop builds reaching this Mac's local services");
  words.push(after.mode === "open" ? "Builds may then reach any host." : after.hosts.length === 0 ? "Builds then reach no extra hosts." : `Builds may then reach ${after.hosts.join(", ")}.`);
  return words;
}

/** The terms of one pending network request of `repo`, against the setting now; why not, in words. */
export function networkRequestTerms(store: Pick<Store, "projectNetwork">, request: AgentRequest, repo: string): { ok: true; terms: NetworkRequestTerms } | { ok: false; problem: string } {
  if (request.kind !== "network" || request.repo !== repo) return { ok: false, problem: "That request isn't about this project's network." };
  if (request.status !== "pending") return { ok: false, problem: "That request was already answered." };
  const change = readNetworkChange(request.params);
  if (change === null) return { ok: false, problem: NETWORK_REQUEST_OLD };
  const before = store.projectNetwork(repo);
  const after: ProjectNetwork = {
    mode: change.mode ?? before.mode,
    hosts: [...new Set([...before.hosts.filter(one => !change.remove.includes(one)), ...change.add])].sort(),
    loopback: change.local ?? before.loopback,
  };
  if (after.hosts.length > MAX_NETWORK_HOSTS) return { ok: false, problem: `A project lists at most ${MAX_NETWORK_HOSTS} hosts.` };
  const digest = createHash("sha256").update(`toolroll:agent-network-request:${canonicalJson({ v: 1, id: request.id, repo, kind: "network", change, before, after })}`, "utf8").digest("hex").slice(0, 32);
  const requester = typeof request.requester === "string" ? request.requester.slice(0, 80) : "Agent";
  const why = typeof request.why === "string" ? request.why.slice(0, 600) : "";
  return { ok: true, terms: { id: request.id, repo, requester, why, change, before, after, digest, words: changeWords(change, after) } };
}

/** Every pending network request of `repo` whose terms can be shown now (oldest first). */
export function pendingNetworkRequests(store: Store, repo: string): NetworkRequestTerms[] {
  const databaseFile = store.databaseFile();
  if (databaseFile === null) return [];
  return listAgentRequests(databaseFile, { status: "pending", repo }).flatMap(one => {
    const read = networkRequestTerms(store, one, repo);
    return read.ok ? [read.terms] : [];
  });
}

/**
 * Approve one network request as `by` (already proved by the caller: an approver of `repo` with a password typed now).
 * In one transaction: the request read again, its terms re-derived from the setting now, refused unless their digest is
 * the one the person was shown, then the setting written and each idle task in the project re-filed on it. The request
 * is marked approved after.
 */
export function approveNetworkRequest(store: Store, input: { id: string; repo: string; digest: string; by: string; now: Date }):
  { ok: true; terms: NetworkRequestTerms; waiting: number } | { ok: false; problem: string } {
  const databaseFile = store.databaseFile();
  if (databaseFile === null) return { ok: false, problem: "That request isn't available." };
  const done = store.transact(() => {
    const request = listAgentRequests(databaseFile).find(one => one.id === input.id);
    if (request === undefined) return { ok: false as const, problem: "That request isn't available." };
    const read = networkRequestTerms(store, request, input.repo);
    if (!read.ok) return read;
    if (read.terms.digest !== input.digest) return { ok: false as const, problem: NETWORK_REQUEST_CHANGED };
    store.setProjectNetwork(input.repo, read.terms.after, input.by, input.now);
    return { ok: true as const, terms: read.terms, waiting: proposeNetworkChanges(store, input.repo, input.now) };
  });
  if (done.ok) resolveAgentRequest(databaseFile, input.id, "approved", done.terms.words.join(" · "), input.now);
  return done;
}
