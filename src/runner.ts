/**
 * A machine that may be given work.
 *
 * Auth is here from the first commit, and that is a deliberate ordering rather
 * than diligence for its own sake. A control plane that dispatches work to
 * unauthenticated runners for six months grows six months of code that assumes
 * the caller is whoever it says it is, and retrofitting identity into that is
 * how the retrofit gets a hole in it. It costs almost nothing to do now.
 *
 * **The token is never stored.** Registration mints one, prints it once, and
 * keeps only a hash. There is no command that recovers it, because a control
 * plane able to hand back a runner's credential is one whose database is worth
 * stealing — and because the same rule governs secrets everywhere else in this
 * design: the control plane holds metadata, the runner holds values.
 *
 * Liveness is separate from a lease expiring, and the distinction matters at
 * 3am. A lease expires because time passed; a runner is dead because it
 * stopped saying otherwise. Reaping on the first tells you a task is free
 * again. Reaping on the second tells you a *machine* is gone, and everything
 * it was holding — claims and worktrees alike — needs recovering together.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { canonicalProject } from "./project.js";
import type { Store, Mutation } from "./store.js";
import { ALL_CREDENTIAL_ENV, PROVIDER_IDS, inspectionOf, type ProviderId } from "./provider.js";
import { attestationOf, versionInRange } from "./attest.js";
import type { ReadinessObservation } from "./phase-routing.js";

/** A runner's repo binding, in the same canonical form task filing uses —
 * the claim gate compares these by equality, so both sides must resolve
 * through one convention (MCP gateway spec v6, the runner tuple). */
export function canonicalRepos(repos: readonly string[]): string[] {
  return repos.map(repo => canonicalProject(repo) ?? resolve(repo));
}

export type Runner = {
  name: string;
  host: string;
  /** How many tasks it will hold at once. */
  capacity: number;
  repos: string[];
  agents: string[];
  registeredAt: string;
  heartbeatAt: string;
  retiredAt: string | null;
  /** The queue column's theme note (v19) — operator prose, display only. */
  queueNote?: string | null;
};

export type Registration = {
  runner: Runner;
  token: string;
  /** What the previous holder of this name was still holding, taken back. */
  reclaimed: Reclaim | null;
};

export type AuthResult =
  | { ok: true; runner: Runner }
  | { ok: false; reason: "unknown" | "bad-token" | "retired" | "expired" };

/** v101: a runner's token lasts a year from its registration; registering again (every start does) renews it. */
export const RUNNER_TOKEN_MS = 365 * 86_400_000;

/**
 * How long a runner may go quiet before it is presumed gone.
 *
 * Comfortably more than any sensible heartbeat interval: declaring a busy
 * machine dead because one check-in was slow costs more than waiting another
 * minute for a machine that really is.
 */
export const DEFAULT_LIVENESS_MS = 3 * 60_000;

export type RegisterOptions = {
  name: string;
  host: string;
  capacity?: number;
  repos?: readonly string[];
  agents?: readonly string[];
  now: Date;
  /** Injected so a test can assert on a token it chose. */
  newToken?: () => string;
  mutation?: Mutation;
};

export function register(store: Store, options: RegisterOptions): Registration {
  const {
    name,
    host,
    capacity = 1,
    repos = [],
    agents = [],
    now,
    newToken = mintToken,
    mutation = {},
  } = options;

  const token = newToken();

  /**
   * Anything the previous holder of this name still had is taken back first.
   *
   * Registering under a name is a new process saying it exists; whatever the
   * last one was holding, it is not holding now. Skipping this is worse than
   * it sounds: the fresh `heartbeat_at` makes the old identity look alive
   * again, so the reaper walks straight past its abandoned claims and
   * worktrees and they are stranded for good.
   */
  const previous = store.getRunner(name);
  const reclaimed: Reclaim | null =
    previous === null
      ? null
      : {
          runner: name,
          claims: store.releaseClaimsOf(name, now),
          worktrees: store.releaseWorktreesOf(name, now),
        };

  const proposed: Runner = {
    name,
    host,
    capacity,
    repos: canonicalRepos(repos),
    agents: [...agents],
    registeredAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    retiredAt: null,
  };

  // The store assigns the incarnation while holding its write transaction.
  // Doing it from the `previous` snapshot above is racy: two registrars can
  // read the same predecessor and otherwise mint the same generation.
  const runner = store.saveRunner(proposed, hashToken(token), mutation);
  return {
    runner,
    token,
    reclaimed:
      reclaimed !== null && (reclaimed.claims.length > 0 || reclaimed.worktrees.length > 0)
        ? reclaimed
        : null,
  };
}

/**
 * Whether this caller is who it says it is.
 *
 * Compared in constant time. The comparison is between hashes rather than
 * secrets, so the practical risk is slight — but a timing-variable equality on
 * a credential path is the kind of thing that gets copied into somewhere it
 * matters, and there is no reason to leave the example lying around.
 */
export function authenticate(store: Store, name: string, token: string): AuthResult {
  const found = store.getRunner(name);
  if (found === null) return { ok: false, reason: "unknown" };
  if (found.runner.retiredAt !== null) return { ok: false, reason: "retired" };
  if (Date.now() - Date.parse(found.runner.registeredAt) > RUNNER_TOKEN_MS) return { ok: false, reason: "expired" };

  return sameDigest(found.credentialHash, hashToken(token))
    ? { ok: true, runner: found.runner }
    : { ok: false, reason: "bad-token" };
}

/**
 * "I am still here." Authenticated AND ATOMIC (arc 2 findings 25/33): the
 * hash is verified and the heartbeat stamped in one write transaction, so
 * a takeover that rotates the credential between the check and the touch
 * cannot receive a stale incarnation's pulse — after rotation commits, the
 * very next heartbeat refuses, and the caller must treat that as fatal.
 */
export function heartbeat(store: Store, name: string, token: string, now: Date): AuthResult {
  return store.transact(() => {
    const auth = authenticate(store, name, token);
    if (!auth.ok) return auth;
    store.touchRunner(name, now);
    return { ok: true, runner: { ...auth.runner, heartbeatAt: now.toISOString() } };
  });
}

/**
 * Extend a live runner's project binding using that runner's own credential.
 *
 * `up` owns both the credential and the registry watcher, so a project the
 * operator admitted through its console can join without a second operator
 * ceremony or a restart. Authentication and the additive write share one
 * transaction: a replaced process cannot widen its successor's binding.
 */
export function addRunnerReposAuthed(
  store: Store,
  args: { name: string; token: string; repos: readonly string[] },
  now: Date,
): AuthResult {
  return store.transact(() => {
    const auth = authenticate(store, args.name, args.token);
    if (!auth.ok) return auth;
    const repos = [...new Set([...auth.runner.repos, ...canonicalRepos(args.repos)])].sort();
    const bound = store.bindRunnerRepos(args.name, repos, now);
    if (!bound.ok) return { ok: false as const, reason: bound.reason };
    store.touchRunner(args.name, now);
    return {
      ok: true as const,
      runner: { ...auth.runner, repos: bound.repos, heartbeatAt: now.toISOString() },
    };
  });
}

/**
 * Narrow a live runner's binding when a project is removed, under the same
 * credential and transaction as addRunnerReposAuthed. `up` calls it only
 * after that project's watch has stopped admitting work.
 */
export function removeRunnerRepoAuthed(
  store: Store,
  args: { name: string; token: string; repo: string },
  now: Date,
): AuthResult {
  return store.transact(() => {
    const auth = authenticate(store, args.name, args.token);
    if (!auth.ok) return auth;
    const bound = store.bindRunnerRepos(args.name, auth.runner.repos.filter(one => one !== args.repo), now);
    if (!bound.ok) return { ok: false as const, reason: bound.reason };
    return { ok: true as const, runner: { ...auth.runner, repos: bound.repos } };
  });
}

/**
 * The one runner-name rule (arc 2 finding 13): nonempty, control-free, at
 * most 60 characters — the console form's rule, now shared by every door.
 */
export const RUNNER_NAME_MAX = 60;

/** The most tasks one worker may be set to run at once (the console's register form says the same). */
export const RUNNER_CAPACITY_MAX = 64;

/** A capacity as typed: a whole number from 1 to RUNNER_CAPACITY_MAX, or null. */
export function parseRunnerCapacity(value: string): number | null {
  const capacity = Number(value.trim());
  return value.trim() !== "" && Number.isInteger(capacity) && capacity >= 1 && capacity <= RUNNER_CAPACITY_MAX ? capacity : null;
}

export function validRunnerName(name: string): boolean {
  if (name === "" || name.length > RUNNER_NAME_MAX) return false;
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/** A generated base name: lowercase [a-z0-9-], collapsed, trimmed. The
 * suffix budget (finding 24) is the CALLER's arithmetic — truncate the
 * base to `RUNNER_NAME_MAX - suffix.length` before appending. */
export function normalizeRunnerName(raw: string): string {
  const collapsed = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (collapsed === "" ? "worker" : collapsed).slice(0, RUNNER_NAME_MAX);
}

/**
 * The atomic take-or-refuse door (arc 2 findings 1/15/16/26/31): ONE write
 * transaction that proves the name is free — absent, retired, or dead by
 * the same predicate recovery uses, with NO unexpired watch lease — then
 * finishes every open run the dead holder left (requeueing what no newer
 * live claim owns), reclaims, and rotates. Two racers serialize: one wins,
 * the other gets the typed refusal.
 */
export function registerRunnerIfIdle(
  store: Store,
  options: RegisterOptions,
):
  | (Registration & { ok: true; recoveredRuns: number })
  | { ok: false; reason: "runner-alive" | "watch-live"; detail: string } {
  const { name, now } = options;
  return store.transact(() => {
    const existing = store.getRunner(name);
    if (existing !== null && existing.runner.retiredAt === null && isAlive(existing.runner, now)) {
      return {
        ok: false as const,
        reason: "runner-alive" as const,
        detail: `${name} heartbeated ${existing.runner.heartbeatAt} — it looks alive`,
      };
    }
    const lease = store.liveWatchLeaseOf(name, now);
    if (lease !== null) {
      return {
        ok: false as const,
        reason: "watch-live" as const,
        detail: `${name} holds a live watch lease on ${lease.repo} until ${lease.until}`,
      };
    }
    // Recovery BEFORE reclaim (finding 16): the open-run evidence must be
    // read while it still exists; register()'s releaseClaimsOf would
    // otherwise hide it from every later recovery.
    const recoveredRuns = existing === null ? 0 : store.recoverRunnerWork(name, now).runs.length;
    // A restart keeps the capacity an operator set; only an explicit one changes it.
    const registration = register(store, { ...options, capacity: options.capacity ?? existing?.runner.capacity ?? 1 });
    return { ok: true as const, ...registration, recoveredRuns };
  });
}

/**
 * The authenticated lease door (arc 2 findings 15/26): credential verified
 * and lease acquired/renewed in the SAME transaction — after a takeover
 * rotates the hash, a stale incarnation can neither acquire nor renew. A
 * takeover of an expired lease recovers the superseded incarnation INSIDE
 * this transaction, so no crash can separate "B owns the lease" from "A
 * was recovered".
 */
export function acquireWatchLeaseAuthed(
  store: Store,
  args: { runner: string; token: string; repo: string; owner: string; ttlMs: number },
  now: Date,
):
  | { ok: true; generation: number; superseded: string | null; recovered: number }
  | { ok: false; reason: "unknown" | "bad-token" | "retired" | "expired" | "watch-busy" | "unauthorized-repo"; holder?: string; until?: string } {
  return store.transact(() => {
    const auth = authenticate(store, args.runner, args.token);
    if (!auth.ok) return { ok: false as const, reason: auth.reason };
    // Watching a repo is a runner road like any other (MCP spec v6,
    // round-4 finding 1): membership is proven in the same transaction
    // as the lease, before any repo activity rides it.
    if (!auth.runner.repos.includes(canonicalProject(args.repo) ?? resolve(args.repo))) {
      return { ok: false as const, reason: "unauthorized-repo" as const };
    }
    const got = store.acquireWatchLease(args.runner, args.repo, args.owner, args.ttlMs, now);
    if (!got.ok) return { ok: false as const, reason: "watch-busy" as const, holder: got.holder, until: got.until };
    const recovered = got.superseded === null ? 0 : store.recoverIncarnation(args.runner, got.superseded, now);
    return { ok: true as const, generation: got.generation, superseded: got.superseded, recovered };
  });
}

/** The renewal, equally authenticated: a false answer is FATAL to the
 * caller — a loop that keeps admitting work after losing its lease or its
 * credential is the exact hole the doors exist to close. */
export function heartbeatWatchLeaseAuthed(
  store: Store,
  args: { runner: string; token: string; repo: string; owner: string; ttlMs: number },
  now: Date,
): boolean {
  return store.transact(() => {
    const auth = authenticate(store, args.runner, args.token);
    if (!auth.ok) return false;
    const renewed = store.heartbeatWatchLease(args.runner, args.repo, args.owner, args.ttlMs, now);
    if (renewed) store.touchRunner(args.runner, now);
    return renewed;
  });
}

/**
 * Retirement fenced by THIS holder's credential (arc 2 finding 28): a
 * successor that already rotated makes the predecessor's cleanup a typed
 * no-op instead of retiring the winner.
 */
export function retireRunnerIfCurrent(
  store: Store,
  name: string,
  token: string,
  now: Date,
): { ok: true } | { ok: false; reason: "unknown" | "bad-token" | "retired" | "expired" } {
  return store.transact(() => {
    const auth = authenticate(store, name, token);
    if (!auth.ok) return { ok: false as const, reason: auth.reason };
    store.retireRunner(name, now);
    return { ok: true as const };
  });
}

export function isAlive(runner: Runner, now: Date, livenessMs = DEFAULT_LIVENESS_MS): boolean {
  if (runner.retiredAt !== null) return false;
  const last = Date.parse(runner.heartbeatAt);
  if (Number.isNaN(last)) return false;
  return now.getTime() - last < livenessMs;
}

/** Runners that have stopped saying they are there. */
export function deadRunners(store: Store, now: Date, livenessMs = DEFAULT_LIVENESS_MS): Runner[] {
  return store.listRunners().filter(runner => !isAlive(runner, now, livenessMs));
}

/** What a re-registration takes back from the previous holder of its name. */
export type Reclaim = {
  runner: string;
  /** Lease ids released because the machine holding them is gone. */
  claims: string[];
  /** Worktree paths handed back to the pool. */
  worktrees: string[];
};

/** What one reconcile pass took back from a proven-dead runner. */
export type Recovery = Reclaim & {
  /** Run ids finished as failed/interrupted because the machine that opened
   * them is gone — including runs whose claim a reaper or the runner itself
   * had already released (P0.1a). */
  runs: number[];
  /** Built-in task ids returned to the queue because no newer live lease
   * owned them once the dead runner's rows were settled. */
  requeued: string[];
};

/** Whether a pass found anything at all to take back. */
export function recoveredAnything(one: Recovery): boolean {
  return one.claims.length > 0 || one.worktrees.length > 0 || one.runs.length > 0 || one.requeued.length > 0;
}

/**
 * Take back everything a dead runner was holding.
 *
 * Claims, open runs, and worktrees together, in one pass, because they are
 * halves of the same fact: the machine is gone. Recovering one and not the
 * others leaves a task dispatchable with its working copy still checked out
 * to a process that no longer exists — which fails later, further away, and
 * looks like a git problem rather than a scheduling one — or a run record
 * that stays open forever after its lease was released and a successor
 * finished the work (P0.1a: the real run 1501).
 *
 * Runs settle through the same transactional walk the takeover door uses
 * (`recoverRunnerWork`), AFTER this runner's claims are released: the walk
 * finishes every open run recorded against the runner outside a live held
 * session as failed/interrupted, and requeues its task only when no newer
 * live lease owns it. A finished outcome is never rewritten; a successor's
 * claim, run, worktree, and task state are somebody else's rows and stay
 * exactly as they were.
 *
 * Worktrees are handed back **unverified**. Nobody watched what the dead
 * process was doing when it stopped, so the directory on disk is a claim about
 * the past rather than a description of the present, and something has to look
 * before it is reused.
 */
export function recoverDead(
  store: Store,
  now: Date,
  livenessMs = DEFAULT_LIVENESS_MS,
): Recovery[] {
  const recovered: Recovery[] = [];

  for (const candidate of deadRunners(store, now, livenessMs)) {
    // Death is re-proved inside the transaction that acts on it. The snapshot
    // above is a survey of a moving world: a runner whose pulse lands between
    // the survey and the release is alive, and releasing its claims anyway
    // would take work from a machine that just said "still here" — the exact
    // loss the heartbeat exists to prevent.
    const recovery = store.transact(() => {
      const fresh = store.getRunner(candidate.name);
      if (fresh === null || isAlive(fresh.runner, now, livenessMs)) return null;
      // Claims and worktrees first, so the report names every path handed
      // back; the run walk's own per-task worktree release then finds
      // nothing left to do here.
      const requeued: string[] = [];
      const claims = store.releaseClaimsOf(candidate.name, now, requeued);
      const worktrees = store.releaseWorktreesOf(candidate.name, now);
      const settled = store.recoverRunnerWork(candidate.name, now);
      return { runner: candidate.name, claims, worktrees, runs: settled.runs, requeued: [...new Set([...requeued, ...settled.requeued])] };
    });
    if (recovery !== null) recovered.push(recovery);
  }

  return recovered;
}

/** 32 bytes of randomness, urlsafe, so it survives being pasted anywhere. */
function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function sameDigest(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  // timingSafeEqual throws on a length mismatch, which is itself a leak of
  // sorts; equal-length hex digests make that unreachable in practice, and the
  // guard keeps it from throwing if one is ever malformed.
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---- provider readiness (v47, phase routing) ------------------------------

/**
 * What ONE machine can say about a provider without spending a token:
 * the binary answers `--version`; where a cheap identity probe exists
 * (codex, openrouter: `login status`) whether it is logged in; where a key
 * env var is required (openrouter) whether it is present; and, for an
 * attested provider (gemini), whether the installed version is inside the
 * range this build proved. Claude has no non-spending login check, so an
 * installed claude is UNKNOWN — stated, never upgraded to ready.
 *
 * Every answer carries the probe's own words. The observation is the
 * runner's and is recorded under its name only through the authenticated
 * road below; a runner never reports for another machine.
 */
export type ReadinessProbe = (
  file: string,
  args: readonly string[],
  options?: { timeoutMs?: number; omitEnv?: readonly string[] },
) => Promise<{ code: number; stdout: string; stderr: string; notFound: boolean; timedOut: boolean }>;

const READINESS_PROBE_TIMEOUT_MS = 5_000;

export async function observeProviderReadiness(
  probe: ReadinessProbe,
  env: Record<string, string | undefined> = process.env,
  providers: readonly ProviderId[] = PROVIDER_IDS,
): Promise<Omit<ReadinessObservation, "runner" | "observedAt">[]> {
  return Promise.all(
    providers.map(async provider => {
      const facts = inspectionOf(provider);
      const version = await probe(facts.binary, ["--version"], { timeoutMs: READINESS_PROBE_TIMEOUT_MS, omitEnv: ALL_CREDENTIAL_ENV });
      if (version.notFound) {
        return { provider, state: "unavailable" as const, reason: `\`${facts.binary}\` is not installed on this runner's PATH`, probe: "version" };
      }
      if (version.timedOut || version.code !== 0) {
        return { provider, state: "unavailable" as const, reason: `\`${facts.binary} --version\` ${version.timedOut ? "timed out" : `exited ${version.code}`}`, probe: "version" };
      }
      const installed = version.stdout.trim().split("\n")[0] ?? "";
      const range = attestationOf(provider);
      if (range !== null && !versionInRange(installed, range)) {
        return { provider, state: "unavailable" as const, reason: `installed ${facts.binary} ${installed || "(unversioned)"} is outside this build's attested range ${range.floor}–${range.ceiling}`, probe: "version" };
      }
      if (facts.requiresEnv !== null && (env[facts.requiresEnv] ?? "") === "") {
        return { provider, state: "unavailable" as const, reason: `${facts.requiresEnv} is absent from this runner's environment`, probe: "key" };
      }
      // A key-driven provider (openrouter rides the codex harness on an API
      // key) is ready on key PRESENCE — presence, never authorization — and
      // needs no harness login. A login-driven one asks the harness.
      if (facts.requiresEnv !== null) {
        return { provider, state: "ready" as const, reason: `installed (${installed}); ${facts.requiresEnv} present (presence, not authorization)`, probe: "key" };
      }
      if (facts.identityProbe !== null) {
        const identity = await probe(facts.binary, [...facts.identityProbe], { timeoutMs: READINESS_PROBE_TIMEOUT_MS, omitEnv: ALL_CREDENTIAL_ENV });
        if (identity.code !== 0) {
          return { provider, state: "unavailable" as const, reason: `\`${facts.binary} ${facts.identityProbe.join(" ")}\` says not logged in`, probe: "identity" };
        }
        const who = identity.stdout.trim().split("\n")[0] ?? "";
        return { provider, state: "ready" as const, reason: `installed (${installed}); ${who === "" ? "logged in" : who}`, probe: "identity" };
      }
      return { provider, state: "unknown" as const, reason: `installed (${installed}); no non-spending login check exists — a real run is the proof`, probe: "version" };
    }),
  );
}

/**
 * Record a runner's observations under its OWN authenticated name: the
 * credential is verified and the rows written in one transaction, so a
 * replaced incarnation cannot report for its successor, and no caller can
 * report for a machine it does not hold the token of.
 */
export function reportProviderReadinessAuthed(
  store: Store,
  args: { name: string; token: string; observations: readonly Omit<ReadinessObservation, "runner" | "observedAt">[] },
  now: Date,
): AuthResult {
  return store.transact(() => {
    const auth = authenticate(store, args.name, args.token);
    if (!auth.ok) return auth;
    store.recordProviderReadiness(args.name, args.observations, now);
    return auth;
  });
}
