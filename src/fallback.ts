/**
 * Fallback chains (docs/plans/fallback-chains.md): when an agent runs out of its plan mid-task, the work moves to the
 * next agent a person approved.
 *
 * A person sets a project's chain and its paid grant. Filing snapshots the chain into the scope and the approval seals
 * it. A walk is one pass down a sealed chain for one task; every builder run on a chain approval is bound to one, and
 * a run with no binding spawns nothing. A move happens only in the transaction that seals a recognised exhausted run.
 * The next agent runs through the ordinary claim, keyed to its pinned entry. Paid entries re-read the live grant at the
 * move, the admission and the spawn.
 *
 * Tables may not exist on a database an older build still holds (update drain reads through here): every read treats
 * that as "no chain" (`hasTables`), never an error.
 */
import { createHash } from "node:crypto";
import { resolveScopeProfile } from "./agentconfig.js";
import { isAcpProvider } from "./acp-agents.js";
import { permissionPlainWords } from "./chat-terms.js";
import { limitRecognised } from "./exhaustion.js";
import { SUBSCRIPTION_CAPABLE } from "./keys.js";
import { routeDigestOf } from "./phase-routing.js";
import { isProviderId, validateSpec } from "./provider.js";
import { providerName } from "./provider-auth.js";
import { canonicalChainJson, chainDigestOf, LIVE_CHAIN_VERSION, liveChainFromJson, machineActing, profileDigestOf, type ChainEntry, type ExecutionProfile, type Scope, type UnattendedPermissionMode } from "./scope.js";
import type { Store } from "./store.js";

export const MAX_FALLBACK_ENTRIES = 3;

/** What a project's setting names: the rest of each entry's terms resolve at filing and seal with the approval. */
export type FallbackEntry = { provider: string; model: string; authMode: "subscription" | "api-key" };
export type FallbackSetting = { repo: string; entries: FallbackEntry[]; paidGrant: { by: string; at: string } | null; updatedBy: string; updatedAt: string };

type WalkRow = { id: number; taskRef: number; scopeDigest: string; chainDigest: string; cursor: number; tailRun: number; state: "open" | "closed"; closedReason: string | null };
type RunBinding = { id: number; taskRef: number; role: string; provider: string; model: string | null; outcome: string | null; parentRun: number | null;
  chainCycle: number | null; chainIndex: number | null; entryDigest: string | null; authMode: string | null; terminalClass: string | null; providerStartedAt: string | null; finishedAt: string | null };

const tablesSeen = new WeakSet<object>();
function hasTables(store: Store): boolean {
  if (tablesSeen.has(store.handle)) return true;
  const row = store.handle.prepare("SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = 'fallback_walk'").get();
  if (row === undefined) return false;
  tablesSeen.add(store.handle);
  return true;
}

export function entryDigestOf(entry: ChainEntry): string {
  return createHash("sha256").update(`toolroll:fallback-entry:v1:${profileDigestOf(entry.profile)}:${entry.authMode}`, "utf8").digest("hex").slice(0, 32);
}

const planCapable = (provider: string): boolean => (SUBSCRIPTION_CAPABLE as Record<string, boolean>)[provider] === true;

const billingWord = (authMode: string): string => authMode === "api-key" ? "API key" : "plan";

/** An entry in the words every surface uses. */
export function entryWords(entry: FallbackEntry): string {
  return `${providerName(entry.provider)} ${entry.model} (${billingWord(entry.authMode)})`;
}

/** Whether Toolroll can see this entry run out, in plain words: an entry it can't recognise ends the chain there. */
export function entryMovesOnWords(entry: Pick<FallbackEntry, "provider" | "authMode">): string {
  return limitRecognised(entry.provider, entry.authMode) ? "Moves on when its plan runs out" : "Won't move on: Toolroll can't yet recognise this agent running out";
}

/** Whether this entry spends money, by what it was pinned to: an API key, or a provider that only bills by use. A plan
 * entry is never paid: where its login can't be proved to be that plan, it doesn't run (invoke.ts), it is never
 * reinterpreted as a paid agent. */
export function entryPaid(_store: Store, entry: Pick<FallbackEntry, "provider" | "authMode">): boolean {
  return entry.authMode === "api-key" || !planCapable(entry.provider);
}

// ---- The project setting. Only a person changes it, and every change is logged.

function personOnly(): string | null {
  return machineActing() ? "Only a person can change a project's fallback agents." : null;
}

/** Parse `provider:model:plan|api-key`. The model is everything between the first and last colon, so ":free" ids work. */
export function parseEntry(text: string): FallbackEntry | string {
  const first = text.indexOf(":"), last = text.lastIndexOf(":");
  if (first <= 0 || last <= first) return `"${text}" should read provider:model:plan or provider:model:api-key`;
  const billing = text.slice(last + 1);
  if (billing !== "plan" && billing !== "api-key") return `"${text}" should end in :plan or :api-key`;
  return { provider: text.slice(0, first), model: text.slice(first + 1, last), authMode: billing === "plan" ? "subscription" : "api-key" };
}

export function entriesProblem(entries: readonly FallbackEntry[]): string | null {
  if (entries.length === 0 || entries.length > MAX_FALLBACK_ENTRIES) return `A chain lists 1 to ${MAX_FALLBACK_ENTRIES} fallback agents.`;
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isProviderId(entry.provider) || isAcpProvider(entry.provider)) return `${entry.provider} can't be a fallback agent.`;
    const valid = validateSpec({ provider: entry.provider, model: entry.model });
    if (!valid.ok) return valid.problem;
    if (entry.authMode === "subscription" && !planCapable(entry.provider)) return `${providerName(entry.provider)} has no plan to sign in with; use an API key.`;
    const key = `${entry.provider}\n${entry.model}\n${entry.authMode}`;
    if (seen.has(key)) return `${entryWords(entry)} is listed twice.`;
    seen.add(key);
  }
  return null;
}

export function fallbackSettingOf(store: Store, repo: string): FallbackSetting | null {
  if (!hasTables(store)) return null;
  const row = store.handle.prepare("SELECT * FROM fallback_setting WHERE repo = ?").get(repo);
  if (row === undefined) return null;
  let entries: FallbackEntry[];
  try { entries = JSON.parse(String(row["entries_json"])) as FallbackEntry[]; } catch { entries = []; }
  return { repo, entries, paidGrant: row["paid_granted_by"] == null ? null : { by: String(row["paid_granted_by"]), at: String(row["paid_granted_at"]) }, updatedBy: String(row["updated_by"]), updatedAt: String(row["updated_at"]) };
}

function logSetting(store: Store, repo: string, action: string, by: string, detail: string, now: Date): void {
  store.recordAction({ at: now.toISOString(), actor: by, repo, taskId: null, runId: null, action, outcome: "changed", source: "request", detail });
}

export function setFallbackChain(store: Store, repo: string, entries: readonly FallbackEntry[], by: string, now: Date): { ok: true } | { ok: false; problem: string } {
  const problem = personOnly() ?? entriesProblem(entries);
  if (problem !== null) return { ok: false, problem };
  return store.transact(() => {
    // A chain Toolroll couldn't file refuses here, not on the next task.
    for (const entry of entries) {
      const resolved = resolveEntry(store, repo, entry);
      if (!resolved.ok) return { ok: false as const, problem: `${entryWords(entry)}: ${resolved.problem}` };
    }
    store.handle.prepare(`INSERT INTO fallback_setting (repo, entries_json, updated_by, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (repo) DO UPDATE SET entries_json = excluded.entries_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(repo, JSON.stringify(entries), by, now.toISOString());
    logSetting(store, repo, "fallback agents set", by, entries.map(entryWords).join(" → "), now);
    return { ok: true as const };
  });
}

export function clearFallbackChain(store: Store, repo: string, by: string, now: Date): { ok: true } | { ok: false; problem: string } {
  const problem = personOnly();
  if (problem !== null) return { ok: false, problem };
  store.transact(() => {
    store.handle.prepare("DELETE FROM fallback_setting WHERE repo = ?").run(repo);
    logSetting(store, repo, "fallback agents cleared", by, "New tasks in this project file with no fallback agents.", now);
  });
  return { ok: true };
}

/** The paid grant: the one explicit yes a paid entry spends under, read again at every money moment. */
export function setPaidGrant(store: Store, repo: string, allowed: boolean, by: string, now: Date): { ok: true } | { ok: false; problem: string } {
  const problem = personOnly();
  if (problem !== null) return { ok: false, problem };
  return store.transact(() => {
    const changed = store.handle.prepare("UPDATE fallback_setting SET paid_granted_by = ?, paid_granted_at = ?, updated_by = ?, updated_at = ? WHERE repo = ?")
      .run(allowed ? by : null, allowed ? now.toISOString() : null, by, now.toISOString(), repo);
    if (Number(changed.changes) === 0) return { ok: false as const, problem: "This project has no fallback agents to pay for." };
    logSetting(store, repo, allowed ? "paid fallback allowed" : "paid fallback revoked", by, allowed ? "Paid fallback agents may spend." : "Paid fallback agents may not spend.", now);
    return { ok: true as const };
  });
}

function paidGrantLive(store: Store, repo: string | null): boolean {
  return repo !== null && fallbackSettingOf(store, repo)?.paidGrant != null;
}

// ---- Filing and sealing.

function resolveEntry(store: Store, repo: string, entry: FallbackEntry, permissionMode: UnattendedPermissionMode = "auto"): { ok: true; profile: ExecutionProfile } | { ok: false; problem: string } {
  // "inherit": a repair turn resumes its own agent's session, so its model is the entry's whatever the repair row says.
  const resolved = resolveScopeProfile(store, repo, undefined, { provider: entry.provider, model: entry.model, repairModel: "inherit", permissionMode });
  return resolved.ok ? { ok: true, profile: resolved.profile } : { ok: false, problem: resolved.problem };
}

/**
 * The chain a new scope files with: its base agent, then the project's entries. Null means no chain. A setting that can't
 * resolve is a stated problem: the scope files unresolved in those words, and nothing runs on half a chain.
 */
export function chainForFiling(store: Store, repo: string | null, base: ExecutionProfile, baseAuth: string, lower: (profile: ExecutionProfile) => ExecutionProfile): { ok: true; chain: ChainEntry[] | null } | { ok: false; problem: string } {
  if (repo === null) return { ok: true, chain: null };
  const setting = fallbackSettingOf(store, repo);
  if (setting === null || (baseAuth !== "subscription" && baseAuth !== "api-key")) return { ok: true, chain: null };
  const problem = entriesProblem(setting.entries);
  if (problem !== null) return { ok: false, problem: `This project's fallback agents can't be read: ${problem}` };
  const chain: ChainEntry[] = [{ profile: base, authMode: baseAuth }];
  const seen = new Set([entryDigestOf(chain[0]!)]);
  for (const entry of setting.entries) {
    // An entry never reaches further than the base: full access only where the base already has it.
    const resolved = resolveEntry(store, repo, entry, permissionPlainWords(base)?.startsWith("full access") === true ? "bypassPermissions" : "auto");
    if (!resolved.ok) return { ok: false, problem: `This project's fallback agent ${entryWords(entry)} can't be used: ${resolved.problem}` };
    const one: ChainEntry = { profile: lower(resolved.profile), authMode: entry.authMode };
    if (seen.has(entryDigestOf(one))) continue;
    seen.add(entryDigestOf(one));
    chain.push(one);
  }
  return { ok: true, chain: chain.length < 2 ? null : chain };
}

export const chainJsonOf = (chain: readonly ChainEntry[]): string => canonicalChainJson(chain, LIVE_CHAIN_VERSION);

/**
 * Why this chain can't seal on this yes, or null. A paid entry takes a person's own yes: the ceremony or their chat tap,
 * never a mode, grant, schedule, lead or automatic seal, and no machine's credential. A chat tap is bound to the scope's
 * digest, which covers the chain, and the card shows the chain in full (chainTermsLines).
 */
export function chainSealProblem(store: Store, scope: Scope, basis: { kind: string } | undefined): string | null {
  const chain = liveChainFromJson(scope.proposedChainJson ?? null);
  if (chain === null) return scope.proposedChainJson == null ? null : "this scope's fallback agents can't be read";
  if (!chain.slice(1).some(entry => entryPaid(store, { provider: entry.profile.provider, authMode: entry.authMode }))) return null;
  if (machineActing() || (basis !== undefined && basis.kind !== "chat")) return "a paid fallback agent needs a person's own yes";
  return null;
}

/** The sealed chain, proved: none, or a problem in words, or the entries with their digest. */
type Sealed = { kind: "none" } | { kind: "problem"; problem: string } | { kind: "chain"; chain: ChainEntry[]; digest: string; scope: Scope; routeDigest: string };

function sealedChain(store: Store, taskId: string): Sealed {
  const scope = store.getScope(taskId);
  if (scope === null || scope.approvalKind !== "chain") return { kind: "none" };
  if (scope.approvedAt === null || scope.approvedDigest !== scope.digest) return { kind: "problem", problem: "the approval no longer stands" };
  const route = store.sealedRouteOf(taskId);
  if (!route.ok) return { kind: "problem", problem: route.detail };
  const chain = liveChainFromJson(scope.approvedChainJson ?? null);
  // A chain sealed before v115 still verifies as history; it spends nothing now.
  if (chain === null) return { kind: "problem", problem: "this approval names fallback agents from an older version; save the scope again and approve it" };
  return { kind: "chain", chain, digest: chainDigestOf(chain, LIVE_CHAIN_VERSION), scope, routeDigest: routeDigestOf(route.route) };
}

// ---- The walk.

function walkOf(row: Record<string, unknown> | undefined): WalkRow | null {
  if (row === undefined) return null;
  return { id: Number(row["id"]), taskRef: Number(row["task_ref"]), scopeDigest: String(row["scope_digest"]), chainDigest: String(row["chain_digest"]), cursor: Number(row["cursor"]),
    tailRun: Number(row["tail_run"]), state: row["state"] === "open" ? "open" : "closed", closedReason: row["closed_reason"] == null ? null : String(row["closed_reason"]) };
}

const openWalk = (store: Store, taskRef: number): WalkRow | null => walkOf(store.handle.prepare("SELECT * FROM fallback_walk WHERE task_ref = ? AND state = 'open'").get(taskRef));

function bindingOf(store: Store, runId: number): RunBinding | null {
  const row = store.handle.prepare("SELECT id, task_ref, role, provider, model, outcome, parent_run, chain_cycle, chain_index, entry_digest, auth_mode, terminal_class, provider_started_at, finished_at FROM run WHERE id = ?").get(runId);
  if (row === undefined) return null;
  const opt = (key: string): string | null => row[key] == null ? null : String(row[key]);
  const num = (key: string): number | null => row[key] == null ? null : Number(row[key]);
  return { id: Number(row["id"]), taskRef: Number(row["task_ref"]), role: String(row["role"]), provider: String(row["provider"]), model: opt("model"), outcome: opt("outcome"), parentRun: num("parent_run"),
    chainCycle: num("chain_cycle"), chainIndex: num("chain_index"), entryDigest: opt("entry_digest"), authMode: opt("auth_mode"), terminalClass: opt("terminal_class"), providerStartedAt: opt("provider_started_at"), finishedAt: opt("finished_at") };
}

const pendingMove = (store: Store, walk: number, index: number): boolean =>
  store.handle.prepare("SELECT 1 AS hit FROM fallback_move WHERE walk = ? AND to_index = ? AND to_run IS NULL").get(walk, index) !== undefined;

function closeWalk(store: Store, id: number, reason: string, now: Date): void {
  store.handle.prepare("UPDATE fallback_walk SET state = 'closed', closed_reason = ?, closed_at = ? WHERE id = ? AND state = 'open'").run(reason, now.toISOString(), id);
}

/**
 * THE ONE RESOLVER: what a walk's tail says about the walk. An open tail or a move waiting to run leaves it; a parked
 * tail keeps it, because the answer resumes that agent; a built tail closes it; anything else closes it, and the retry
 * starts a fresh walk at the base. Whichever pass gets here, after any crash, settles it the same way.
 */
function settleWalk(store: Store, walk: WalkRow, now: Date): void {
  const ref = store.refForId(walk.taskRef);
  const scope = ref === null ? null : store.getScope(ref.externalId);
  if (ref === null || scope === null || scope.approvedDigest !== walk.scopeDigest || scope.digest !== walk.scopeDigest) { closeWalk(store, walk.id, "approval-changed", now); return; }
  const pending = pendingMove(store, walk.id, walk.cursor);
  const tail = bindingOf(store, walk.tailRun);
  const finished = !pending && (tail?.outcome === "built" || tail?.outcome === "no-change");
  const state = store.getTask(ref.externalId)?.state;
  if (state === "cancelled" || state === "done") { closeWalk(store, walk.id, finished ? "succeeded" : "task-ended", now); return; }
  if (pending) return;
  if (tail === null) { closeWalk(store, walk.id, "entry-ended", now); return; }
  if (tail.outcome === null || tail.outcome === "parked") return;
  closeWalk(store, walk.id, finished ? "succeeded" : "entry-ended", now);
}

/** Each tick, before any dispatch: settle every open walk. */
export function reconcileWalks(store: Store, now: Date): void {
  if (!hasTables(store)) return;
  store.transact(() => {
    for (const row of store.handle.prepare("SELECT * FROM fallback_walk WHERE state = 'open' ORDER BY id").all()) settleWalk(store, walkOf(row)!, now);
  });
}

export type FallbackDispatch = { index: number; entry: ChainEntry; paid: boolean } | { problem: string } | null;

/**
 * Which entry the next build of this task runs as, read by the tick before anything is claimed: null is the ordinary
 * road (no chain, or the base agent). A move whose paid grant has since gone closes here and says so: nothing runs on it.
 */
export function dispatchEntryOf(store: Store, taskRef: number, taskId: string, now: Date): FallbackDispatch {
  if (!hasTables(store)) return null;
  const sealed = sealedChain(store, taskId);
  if (sealed.kind === "none") return null;
  if (sealed.kind === "problem") return { problem: sealed.problem };
  return store.transact(() => {
    const before = openWalk(store, taskRef);
    if (before !== null) settleWalk(store, before, now);
    const walk = openWalk(store, taskRef);
    if (walk === null || walk.cursor === 0) return null;
    if (walk.chainDigest !== sealed.digest) { closeWalk(store, walk.id, "approval-changed", now); return null; }
    const entry = sealed.chain[walk.cursor];
    if (entry === undefined) { closeWalk(store, walk.id, "chain-ended", now); return null; }
    const paid = entryPaid(store, { provider: entry.profile.provider, authMode: entry.authMode });
    if (paid && !paidGrantLive(store, store.refForId(taskRef)?.repo ?? null)) { closeWalk(store, walk.id, "grant-withheld", now); return null; }
    return { index: walk.cursor, entry, paid };
  });
}

/** A route stamp for a fallback entry, checked against the sealed chain: the admission's proof of `fallback` provenance. */
export function fallbackStampProblem(store: Store, taskRef: number, taskId: string, stamp: { routeDigest: string; phase: string; provider: string; model: string | null }, parentRun: number | null): string | null {
  if (!hasTables(store)) return "this database has no fallback records yet";
  const sealed = sealedChain(store, taskId);
  if (sealed.kind !== "chain") return sealed.kind === "problem" ? sealed.problem : "this approval names no fallback agents";
  if (stamp.routeDigest !== sealed.routeDigest) return "the stamp names a route the approval doesn't";
  const walk = openWalk(store, taskRef);
  if (walk === null) return "no walk is open for this task";
  const entry = sealed.chain[walk.cursor];
  if (entry === undefined || walk.cursor === 0) return "the chain has no fallback entry here";
  const model = stamp.phase === "repair" ? (entry.profile.repairModel === "inherit" ? entry.profile.model : entry.profile.repairModel) : entry.profile.model;
  if (stamp.provider !== entry.profile.provider || stamp.model !== model) return `the chain's entry is ${entry.profile.provider} · ${model}, not ${stamp.provider} · ${stamp.model ?? "(none)"}`;
  if (stamp.phase === "repair") {
    const parent = parentRun === null ? null : bindingOf(store, parentRun);
    if (parent === null || parent.id !== walk.tailRun) return "a fallback repair mends the walk's own attempt";
  } else if (stamp.phase !== "build") return "only a build or its repair runs as a fallback";
  return null;
}

function stampRun(store: Store, runId: number, walk: number, index: number, entry: ChainEntry): void {
  store.handle.prepare("UPDATE run SET chain_cycle = ?, chain_index = ?, entry_digest = ?, auth_mode = ? WHERE id = ?").run(walk, index, entryDigestOf(entry), entry.authMode, runId);
}

/**
 * Inside the run's admission transaction: bind it to its walk, or say why not (the caller rolls the row back). A base run
 * opens a walk; a pending entry consumes its edge exactly once, with the paid grant re-read; a parked tail hands custody to
 * its resumption; a repair inherits its parent's binding verbatim. Nothing else opens on a chain approval.
 */
export function bindRunToWalk(store: Store, runId: number, now: Date): string | null {
  if (!hasTables(store)) return null;
  const run = bindingOf(store, runId);
  if (run === null || (run.role !== "builder" && run.role !== "repair")) return null;
  const ref = store.refForId(run.taskRef);
  if (ref === null) return null;
  const sealed = sealedChain(store, ref.externalId);
  if (sealed.kind === "none") return null;
  if (sealed.kind === "problem") return sealed.problem;
  if (run.role === "repair") {
    const parent = run.parentRun === null ? null : bindingOf(store, run.parentRun);
    if (parent === null || parent.chainCycle === null || parent.chainIndex === null) return "this repair's attempt holds no place in a walk";
    const entry = sealed.chain[parent.chainIndex];
    if (entry === undefined) return "this repair's attempt holds no place in the chain";
    stampRun(store, run.id, parent.chainCycle, parent.chainIndex, entry);
    return null;
  }
  const open = openWalk(store, run.taskRef);
  if (open !== null) settleWalk(store, open, now);
  const walk = openWalk(store, run.taskRef);
  if (walk === null) {
    const base = sealed.chain[0]!;
    if (run.provider !== base.profile.provider || run.model !== base.profile.model) return "a new walk starts at the chain's base agent";
    const made = store.handle.prepare("INSERT INTO fallback_walk (task_ref, scope_digest, chain_digest, tail_run, opened_at) VALUES (?, ?, ?, ?, ?)")
      .run(run.taskRef, sealed.scope.digest, sealed.digest, run.id, now.toISOString());
    stampRun(store, run.id, Number(made.lastInsertRowid), 0, base);
    return null;
  }
  if (walk.chainDigest !== sealed.digest || walk.scopeDigest !== sealed.scope.digest) return "the walk was opened under another approval";
  const entry = sealed.chain[walk.cursor];
  if (entry === undefined) return "the walk's place isn't in the chain";
  if (run.provider !== entry.profile.provider || run.model !== entry.profile.model) return `the walk is at ${entry.profile.provider} · ${entry.profile.model}, not ${run.provider} · ${run.model ?? "(none)"}`;
  if (entryPaid(store, { provider: entry.profile.provider, authMode: entry.authMode }) && !paidGrantLive(store, ref.repo)) return "paid fallback isn't allowed for this project";
  if (pendingMove(store, walk.id, walk.cursor)) {
    const took = store.handle.prepare("UPDATE fallback_move SET to_run = ? WHERE walk = ? AND to_index = ? AND to_run IS NULL").run(run.id, walk.id, walk.cursor);
    if (Number(took.changes) !== 1) return "this move was already admitted";
  } else if (bindingOf(store, walk.tailRun)?.outcome !== "parked") return "the walk's attempt is still running";
  store.handle.prepare("UPDATE fallback_walk SET tail_run = ? WHERE id = ?").run(run.id, walk.id);
  stampRun(store, run.id, walk.id, walk.cursor, entry);
  return null;
}

/** The pinned entry a bound run spends as, or null for a run with no binding. */
export function pinnedEntryOf(store: Store, runId: number): { index: number; entry: ChainEntry } | { problem: string } | null {
  if (!hasTables(store)) return null;
  const run = bindingOf(store, runId);
  if (run === null || run.chainCycle === null || run.chainIndex === null) return null;
  const ref = store.refForId(run.taskRef);
  const sealed = ref === null ? null : sealedChain(store, ref.externalId);
  if (sealed === null || sealed.kind !== "chain") return { problem: sealed !== null && sealed.kind === "problem" ? sealed.problem : "the approval no longer names this chain" };
  const entry = sealed.chain[run.chainIndex];
  if (entry === undefined || entryDigestOf(entry) !== run.entryDigest) return { problem: "this run's fallback entry isn't in the approved chain" };
  return { index: run.chainIndex, entry };
}

/**
 * THE LAST LOOK AT THE SPAWN: one read of every authority a chain run spends under. A builder or repair on a chain
 * approval with no binding spends nothing; a bound run must hold the walk's current place, under the live approval, as its
 * exact entry; a paid entry must still hold the live grant. Null means go.
 */
export function chainCustodyProblem(store: Store, runId: number): string | null {
  if (!hasTables(store)) return null;
  return store.transact(() => {
    const run = bindingOf(store, runId);
    if (run === null || (run.role !== "builder" && run.role !== "repair")) return null;
    const ref = store.refForId(run.taskRef);
    if (ref === null) return null;
    const sealed = sealedChain(store, ref.externalId);
    if (sealed.kind === "none") return run.chainCycle === null ? null : "this run is bound to a chain the approval no longer names";
    if (sealed.kind === "problem") return sealed.problem;
    if (run.chainCycle === null || run.chainIndex === null) return "nothing spends on a chain approval outside its walk";
    const walk = walkOf(store.handle.prepare("SELECT * FROM fallback_walk WHERE id = ?").get(run.chainCycle));
    if (walk === null || walk.state !== "open") return "this run's walk has closed";
    if (walk.chainDigest !== sealed.digest || walk.scopeDigest !== sealed.scope.digest) return "this run's walk was opened under another approval";
    if (walk.cursor !== run.chainIndex) return "this run no longer holds the walk's place";
    if (walk.tailRun !== run.id && !(run.role === "repair" && run.parentRun === walk.tailRun)) return "this run no longer holds the walk's place";
    const entry = sealed.chain[run.chainIndex];
    if (entry === undefined || entryDigestOf(entry) !== run.entryDigest || entry.profile.provider !== run.provider || entry.authMode !== run.authMode) return "this run isn't the entry that was approved";
    if (entryPaid(store, { provider: entry.profile.provider, authMode: entry.authMode }) && !paidGrantLive(store, ref.repo)) return "paid fallback isn't allowed for this project";
    return null;
  });
}

/** A builder's newest repair turn, when it ran out of plan holding the builder's exact place in the walk: the evidence a
 * repair turn gives its owning attempt. Any newer turn, a turn that never spawned or never finished, or one bound
 * elsewhere, is none. */
function exhaustedRepairOf(store: Store, run: RunBinding): RunBinding | null {
  const row = store.handle.prepare("SELECT id FROM run WHERE parent_run = ? AND role = 'repair' ORDER BY id DESC LIMIT 1").get(run.id);
  const child = row === undefined ? null : bindingOf(store, Number(row["id"]));
  if (child === null || child.terminalClass !== "usage-exhausted" || child.providerStartedAt === null || child.outcome === null) return null;
  if (child.taskRef !== run.taskRef || child.chainCycle !== run.chainCycle || child.chainIndex !== run.chainIndex || child.entryDigest !== run.entryDigest) return null;
  return child;
}

/** Whether this finished attempt is about to move on: it holds a walk's place and the gateway classed it exhausted. */
export function ranOutOnChain(store: Store, runId: number): boolean {
  if (!hasTables(store)) return false;
  const run = bindingOf(store, runId);
  return run !== null && run.chainCycle !== null && run.terminalClass === "usage-exhausted";
}

/** How long after a fallback agent was refused for not being signed in to its plan the task stops moving to it: its
 * retries then take the ordinary road, with strikes, instead of looping through the base agent. */
export const SIGNED_OUT_WINDOW_MS = 30 * 60_000;

/** The gateway refused this bound run: its plan login isn't proved. The walk closes, a person is told, no strike. */
export function closeWalkSignedOut(store: Store, runId: number, now: Date): void {
  if (!hasTables(store)) return;
  store.transact(() => {
    const run = bindingOf(store, runId);
    if (run === null || run.chainCycle === null) return;
    const closed = store.handle.prepare("UPDATE fallback_walk SET state = 'closed', closed_reason = 'entry-signed-out', closed_at = ? WHERE id = ? AND state = 'open'").run(now.toISOString(), run.chainCycle);
    if (Number(closed.changes) === 0) return;
    const ref = store.refForId(run.taskRef);
    store.enqueueNotification({
      source: { run: run.id }, dedupeKey: `fallback:signed-out:${run.id}`, kind: "fallback", pushClass: "attention", link: `/r/${run.id}`,
      subject: `${ref?.externalId ?? "A task"}: ${providerName(run.provider)} isn't signed in to its plan`,
      body: `The next approved agent runs on its plan, but ${providerName(run.provider)} here isn't signed in to one. Nothing ran and nothing was spent. Sign it in to its plan, then requeue.`,
    }, now);
  });
}

function signedOutRecently(store: Store, taskRef: number, now: Date): boolean {
  const since = new Date(now.getTime() - SIGNED_OUT_WINDOW_MS).toISOString();
  return store.handle.prepare("SELECT 1 AS hit FROM fallback_walk WHERE task_ref = ? AND closed_reason = 'entry-signed-out' AND closed_at >= ?").get(taskRef, since) !== undefined;
}

export type MoveResult = { moved: true; to: FallbackEntry; paid: boolean } | null;

/**
 * THE MOVE, inside sealFailure's transaction (the claim is already released, the run still open): only the walk's own tail,
 * started and classed exhausted by the gateway, on the exact entry it was pinned to. Null means the ordinary failure road
 * runs, with the walk closed in words when it can't go on. The caller finishes the run either way; a walk that moved leaves
 * no strike.
 */
export function moveOnIfExhausted(store: Store, runId: number, taskId: string, now: Date): MoveResult {
  if (!hasTables(store)) return null;
  const run = bindingOf(store, runId);
  if (run === null || run.outcome !== null || run.providerStartedAt === null) return null;
  if (run.role !== "builder" || run.chainCycle === null || run.chainIndex === null) return null;
  // The evidence: this attempt's own terminal, or its last repair turn's, proved to hold the same place on the same entry.
  const evidence = run.terminalClass === "usage-exhausted" ? run : exhaustedRepairOf(store, run);
  if (evidence === null) return null;
  const walk = openWalk(store, run.taskRef);
  if (walk === null || walk.id !== run.chainCycle || walk.tailRun !== run.id || walk.cursor !== run.chainIndex) return null;
  const sealed = sealedChain(store, taskId);
  if (sealed.kind !== "chain" || sealed.digest !== walk.chainDigest || sealed.scope.digest !== walk.scopeDigest) { closeWalk(store, walk.id, "approval-changed", now); return null; }
  const from = sealed.chain[run.chainIndex];
  if (from === undefined || entryDigestOf(from) !== run.entryDigest || from.profile.provider !== run.provider || from.authMode !== run.authMode || !limitRecognised(run.provider, from.authMode)
    || evidence.provider !== run.provider || evidence.authMode !== run.authMode) {
    closeWalk(store, walk.id, "entry-ended", now);
    return null;
  }
  const next = sealed.chain[run.chainIndex + 1];
  if (next === undefined) { closeWalk(store, walk.id, "chain-ended", now); tell(store, run, taskId, "chain-ended", null, now); return null; }
  // Its next agent was just refused for not being signed in to its plan: no loop through the base, the ordinary road.
  if (signedOutRecently(store, run.taskRef, now)) { closeWalk(store, walk.id, "entry-signed-out", now); return null; }
  const to: FallbackEntry = { provider: next.profile.provider, model: next.profile.model, authMode: next.authMode };
  const paid = entryPaid(store, to);
  if (paid && !paidGrantLive(store, store.refForId(run.taskRef)?.repo ?? null)) {
    closeWalk(store, walk.id, "grant-withheld", now);
    tell(store, run, taskId, "grant-withheld", to, now);
    return null;
  }
  store.handle.prepare("INSERT INTO fallback_move (walk, to_index, from_run, terminal_class, paid, moved_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(walk.id, run.chainIndex + 1, run.id, evidence.terminalClass, paid ? 1 : 0, now.toISOString());
  store.handle.prepare("UPDATE fallback_walk SET cursor = ? WHERE id = ?").run(run.chainIndex + 1, walk.id);
  store.handle.prepare("UPDATE task SET state = 'queued', updated_at = ? WHERE id = ? AND state = 'running'").run(now.toISOString(), taskId);
  store.recordAction({ at: now.toISOString(), actor: "toolroll", repo: store.refForId(run.taskRef)?.repo ?? null, taskId, runId: run.id, action: "work moved to fallback agent", outcome: paid ? "paid" : "plan", source: "work", detail: entryWords(to) });
  tell(store, run, taskId, "moved", to, now);
  store.bumpWake();
  return { moved: true, to, paid };
}

function tell(store: Store, run: RunBinding, taskId: string, what: "moved" | "chain-ended" | "grant-withheld", to: FallbackEntry | null, now: Date): void {
  const agent = providerName(run.provider);
  store.enqueueNotification({
    source: { run: run.id },
    dedupeKey: `fallback:${what}:${run.id}`,
    kind: "fallback",
    ...(what === "moved" ? {} : { pushClass: "attention" as const }),
    link: `/r/${run.id}`,
    subject: what === "moved" ? `${taskId}: moved to ${entryWords(to!)}` : `${taskId}: ${agent} ran out and the work can't move on`,
    body: what === "moved" ? `${agent} ran out of its plan. Its work was kept and the next approved agent continues it.`
      : what === "grant-withheld" ? `The next agent, ${entryWords(to!)}, is paid and this project doesn't allow paid fallback. Allow it, or wait for the plan to reset and requeue.`
      : "Every approved agent has run out. Wait for a plan to reset and requeue.",
  }, now);
}

/**
 * What the next agent is told about the move, for its brief. The one place the handover note plugs in: once it merges, a
 * fallback run gets that note here. Null for any run that isn't continuing another agent's work.
 */
export function fallbackBriefFor(store: Store, runId: number): string | null {
  if (!hasTables(store)) return null;
  const row = store.handle.prepare("SELECT m.from_run FROM fallback_move m WHERE m.to_run = ?").get(runId);
  if (row === undefined) return null;
  const from = bindingOf(store, Number(row["from_run"]));
  if (from === null) return null;
  return `Another agent (${providerName(from.provider)}) started this task and ran out of its plan before finishing. Whatever it wrote is already on this branch, as a work-in-progress commit if there were changes. Read the branch first and continue from it; don't start again.`;
}
