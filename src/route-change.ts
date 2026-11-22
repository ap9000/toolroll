/**
 * One step to approve a new route (docs/plans/plain-toolroll.md P2.5). There are no route classes: an approval stays
 * bound to its exact route, and dispatch runs on no other bytes. When the route a task would dispatch on differs from the
 * sealed one, Toolroll files the same words again on today's route (nothing is sealed) and keeps one "what changed" line,
 * bound to that route's digest, for the one Approve. A legacy row with no route gets the same.
 *
 * approve() reads routeChangeProblem: a line that doesn't describe the route being approved refuses "changed".
 */
import { providerName } from "./provider-auth.js";
import { legOf, routeDigestOf, routeFromJson, type PhaseRoute } from "./phase-routing.js";
import { deployGateScope, releaseCheckScope, type Scope } from "./scope.js";
import { BUILT_IN, type Store } from "./store.js";
import { repositoryEcosystems, resolveNetwork, type NetworkProfile } from "./egress.js";

const ROLE: Readonly<Record<"plan" | "build" | "repair" | "review", string>> = { plan: "planner", build: "builder", repair: "repair agent", review: "reviewer" };
type Pair = { provider: string; model: string | null };
const named = (one: Pair): string => `${providerName(one.provider)} ${one.model ?? "(its default model)"}`;
const billing = (mode: string | null | undefined): string | null => mode === "api-key" ? "API key" : mode === "subscription" ? "subscription" : null;

/** What changed in what builds may reach, sealed against proposed: one clause each, in plain words. */
export function networkChangeWords(was: NetworkProfile | null | undefined, now: NetworkProfile | null | undefined): string[] {
  if (was == null || now == null) return [];
  const out: string[] = [];
  if (was.mode !== now.mode) out.push(now.mode === "open" ? "builds may now reach any host" : "builds now reach only their allowed hosts");
  else if (now.mode === "allowlist") {
    const added = now.hosts.filter(one => !was.hosts.includes(one)), gone = was.hosts.filter(one => !now.hosts.includes(one));
    if (added.length > 0) out.push(`builds may now also reach ${added.join(", ")}`);
    if (gone.length > 0) out.push(`builds no longer reach ${gone.join(", ")}`);
  }
  if (was.loopback !== now.loopback) out.push(now.loopback === "any" ? "builds may now reach this Mac's local services" : "builds no longer reach this Mac's local services");
  return out;
}

const sentence = (clauses: readonly string[]): string => clauses.length === 0 ? "" : `${clauses[0]!.charAt(0).toUpperCase()}${clauses.join("; ").slice(1)}`;

/** The sentence for what changed between the seal and the proposal. */
export function routeChangeWords(sealed: { route: PhaseRoute | null; profile: Scope["approvedProfile"] | null | undefined; authMode?: string | null }, next: { route: PhaseRoute; authMode?: string | null }, network: readonly string[] = []): string {
  const changes: string[] = [];
  for (const phase of ["build", "plan", "repair", "review"] as const) {
    const now = legOf(next.route, phase);
    const was: Pair | null = sealed.route !== null ? legOf(sealed.route, phase) : phase === "build" && sealed.profile != null ? { provider: sealed.profile.provider, model: "model" in sealed.profile ? (sealed.profile.model ?? null) : null } : null;
    if (was === null) { if (phase === "build") changes.push(`The builder is ${named(now)}`); continue; }
    if (was.provider === now.provider && was.model === now.model) continue;
    const line = `changes from ${named(was)} to ${named(now)}`;
    // The repair agent is the builder's usual twin: one change is one sentence.
    if (changes.some(one => one.endsWith(line))) continue;
    changes.push(`${changes.length === 0 ? "The" : "the"} ${ROLE[phase]} ${line}`);
  }
  const from = billing(sealed.authMode), to = billing(next.authMode);
  const paid = from !== null && to !== null && from !== to ? ` (${from} → ${to})` : "";
  if (changes.length === 0 && network.length === 0) return "The agents' settings changed since you approved this. Approve to continue.";
  if (changes.length === 0) return `${sentence(network)}. Approve to continue.`;
  return `${changes.join("; ")}${paid}${network.length === 0 ? "" : `; ${network.join("; ")}`}. Approve to continue.`;
}

/** File the same words on today's route, and keep the line. Null: nothing to propose (a release, nothing changed, or no
 * route Toolroll can name), and the task stays as it is. It seals nothing. */
export function proposeNewRoute(store: Store, taskRef: number, taskId: string, now: Date): { words: string } | null {
  return store.transact(() => {
    const before = store.getScope(taskId);
    if (before === null || deployGateScope(before) || releaseCheckScope(before)) return null;
    const sealedRoute = routeFromJson(before.approvedRouteJson ?? null);
    const refiled = store.refileScope(taskId, now);
    if (refiled === null || refiled.profileState === "unresolved") return null;
    const route = routeFromJson(refiled.proposedRouteJson ?? null);
    if (route === null) return null;
    if (refiled.approvedDigest === refiled.digest) return null;
    // How the last attempt billed, against how the new builder would: said when they differ.
    const lastBilled = store.runsFor(taskRef).find(one => one.role === "builder")?.authMode ?? null;
    const billed = store.agentsFor([legOf(route, "build").provider])[0]?.billing ?? null;
    const words = routeChangeWords({ route: sealedRoute, profile: before.approvedProfile ?? null, authMode: lastBilled }, { route, authMode: billed },
      networkChangeWords(before.approvedProfile?.network, refiled.profile?.network));
    store.handle.prepare(`INSERT INTO route_change (task_ref, scope_digest, to_route_digest, words, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (task_ref) DO UPDATE SET scope_digest = excluded.scope_digest, to_route_digest = excluded.to_route_digest, words = excluded.words, created_at = excluded.created_at`)
      .run(taskRef, refiled.digest, routeDigestOf(route), words, now.toISOString());
    return { words };
  });
}

/** The line for this task's waiting plan, or null. Only while it describes exactly the plan up for approval. */
export function routeChangeOf(store: Store, taskId: string): string | null {
  const ref = store.lookupRef(taskId);
  if (ref === null) return null;
  const row = store.handle.prepare("SELECT scope_digest, to_route_digest, words FROM route_change WHERE task_ref = ?").get(ref.id);
  const scope = store.getScope(taskId);
  if (row === undefined || scope === null || scope.digest !== row["scope_digest"] || scope.approvedDigest === scope.digest) return null;
  const route = routeFromJson(scope.proposedRouteJson ?? null);
  return route !== null && routeDigestOf(route) === row["to_route_digest"] ? String(row["words"]) : null;
}

/** Each sweep: an unapproved row from before routing gets its route, and the same one Approve. A standing old approval
 * is left alone (the stale check reaches it if its route ever differs). */
export function routeLegacyPlans(store: Store, now: Date): number {
  const rows = store.handle.prepare(`SELECT r.id AS ref, r.external_id AS task FROM task_scope s JOIN task_ref r ON r.external_id = s.task_id AND r.backend = ? JOIN task t ON t.id = r.external_id
    WHERE s.route_era IS NULL AND t.state = 'queued' AND (s.approved_digest IS NULL OR s.approved_digest <> s.digest) LIMIT 20`).all(BUILT_IN);
  let routed = 0;
  for (const row of rows) if (proposeNewRoute(store, Number(row["ref"]), String(row["task"]), now) !== null) routed++;
  return routed;
}

/**
 * After a project's network setting changes (local services, hosts, open or not): each of its idle tasks whose approval
 * sealed a different network gets the same words filed on the new one and the one line saying what changed, and waits
 * for the same Approve. An approval never widens or narrows by itself; a running task keeps the network it started with.
 */
export function proposeNetworkChanges(store: Store, repo: string, now: Date): number {
  const rows = store.handle.prepare(`SELECT r.id AS ref, r.external_id AS task FROM task_scope s JOIN task_ref r ON r.external_id = s.task_id AND r.backend = ?
    JOIN task t ON t.id = r.external_id WHERE r.repo = ? AND t.state IN ('queued', 'failed') AND s.approved_digest = s.digest`).all(BUILT_IN, repo);
  if (rows.length === 0) return 0;
  const project = store.projectNetwork(repo);
  const ecosystems = repositoryEcosystems(repo);
  let proposed = 0;
  for (const row of rows) {
    const sealed = store.getScope(String(row["task"]))?.approvedProfile;
    if (sealed == null) continue;
    if (networkChangeWords(sealed.network, resolveNetwork(sealed.provider, project, ecosystems)).length === 0) continue;
    if (proposeNewRoute(store, Number(row["ref"]), String(row["task"]), now) !== null) proposed++;
  }
  return proposed;
}
