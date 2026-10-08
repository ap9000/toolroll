import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomBytes } from "node:crypto";
import { sourceKey } from "./source-key.js";

/**
 * Five failures lock a source/account pair, with exponential backoff. Across sources, failures slow an account and
 * admit only a few unproven checks per minute before password derivation. A validated same-account browser session
 * bypasses that shared admission budget, never a source's own lock. Fabricated names follow the same admission path.
 * Source and name records expire by time. Both use bounded, non-evicting keyed storage, regardless of whether the
 * account exists. Saturation shares overflow buckets without displacing or changing individually tracked state.
 */
export type GuardPolicy = { failuresBeforeLock: number; firstLockMs: number; maxLockMs: number; firstSlowMs: number };
export const DEFAULT_GUARD_POLICY: GuardPolicy = { failuresBeforeLock: 5, firstLockMs: 15 * 60_000, maxLockMs: 24 * 60 * 60_000, firstSlowMs: 60_000 };
const TRACKED = 10_000;
/** Default/loopback source for callers without an explicit native CLI context. */
export const LOCAL_SOURCE = "local";
/** Native CLI only: no HTTP peer or forwarded header can select this source. */
export const CLI_PASSWORD_SOURCE = "local-cli";
export const ACCOUNT_PASSWORD_TRIES = 3;
export const ACCOUNT_PASSWORD_WINDOW_MS = 60_000;
const LOCAL_PEERS: ReadonlySet<string> = new Set(["127.0.0.1", "::1"]);

const passwordSource = new AsyncLocalStorage<string>();
/** Run `work` with every password check inside it counted against `source`. */
export const withPasswordSource = <T>(source: string, work: () => T): T => passwordSource.run(source, work);
/** Where the password being checked now came from (LOCAL_SOURCE outside a request). */
export const currentPasswordSource = (): string => passwordSource.getStore() ?? LOCAL_SOURCE;

/** Set only after the server validates a browser session, never from submitted form fields. */
export const provenPasswordAccount = new AsyncLocalStorage<{ name: string; generation: number } | null>();

type Tries = { failures: number; lockedUntil: number; locks: number; lastAt: number };
type Slowdown = { failures: number; until: number; lastAt: number; admissions: number[]; observedAccount: boolean };

/**
 * Keep the first TRACKED live keys exactly; further keys share TRACKED overflow buckets. Hashes use the guard's
 * private secret, so callers cannot choose collisions. Neither tier evicts live state. Overflow never mutates the
 * exact tier, and cannot move into a freed exact slot until all overflow state expires: moving would reset budgets.
 * A success may clear its exact record, but never a shared bucket (which could also hold another name's failures).
 */
class KeyedGuardState<T extends { lastAt: number }> {
  private readonly entries = new Map<string, T>();
  private readonly overflow = new Map<number, T>();
  constructor(private readonly secret: Buffer, private readonly domain: string) {}

  private hash(key: string): string { return createHmac("sha256", this.secret).update(this.domain).update("\0").update(key).digest("hex"); }
  private bucket(hash: string): number { return parseInt(hash.slice(0, 8), 16) % TRACKED; }

  get(key: string): T | undefined {
    const hash = this.hash(key);
    return this.entries.get(hash) ?? this.overflow.get(this.bucket(hash));
  }

  retain(key: string, create: () => T): T {
    const hash = this.hash(key), kept = this.entries.get(hash);
    if (kept !== undefined) return kept;
    if (this.overflow.size === 0 && this.entries.size < TRACKED) {
      const entry = create();
      this.entries.set(hash, entry);
      return entry;
    }
    const bucket = this.bucket(hash), shared = this.overflow.get(bucket);
    if (shared !== undefined) return shared;
    const entry = create();
    this.overflow.set(bucket, entry);
    return entry;
  }

  clear(key: string): void { this.entries.delete(this.hash(key)); }

  prune(now: number, lifetime: number): number {
    let next = Infinity;
    const pruneEntries = <Key>(entries: Map<Key, T>) => {
      for (const [key, entry] of entries) {
        const expires = entry.lastAt + lifetime;
        if (expires <= now) entries.delete(key);
        else next = Math.min(next, expires);
      }
    };
    pruneEntries(this.entries);
    pruneEntries(this.overflow);
    return next;
  }

  /** Individual source/name records; shared overflow storage has its own fixed TRACKED-bucket bound. */
  get size(): number { return this.entries.size; }
}

export class PasswordGuard {
  private readonly secret = randomBytes(32);
  private readonly sources = new KeyedGuardState<Tries>(this.secret, "source/name");
  private readonly slowdowns = new KeyedGuardState<Slowdown>(this.secret, "name");
  private nextPruneAt = Infinity;
  /** Told once per lock: the account (as typed), and for how long. */
  onLock: ((account: string, lockMs: number) => void) | null = null;
  constructor(readonly policy: GuardPolicy = DEFAULT_GUARD_POLICY) {}

  private static key(account: string): string { return account.trim().toLowerCase().slice(0, 64); }
  private static pair(account: string, source: string): string {
    const key = sourceKey(source);
    return `${LOCAL_PEERS.has(key) ? LOCAL_SOURCE : key}\u0000${PasswordGuard.key(account)}`;
  }

  /** Prune by the supplied time, even below capacity; retain a lock's escalation history for a day. */
  private prune(now: number): void {
    if (now < this.nextPruneAt) return;
    this.nextPruneAt = Math.min(this.sources.prune(now, this.policy.maxLockMs), this.slowdowns.prune(now, this.policy.maxLockMs));
  }

  /** Source-local snapshot for existing callers. Authentication must use preflight to spend the shared budget. */
  lockedFor(account: string, now: number, source: string = currentPasswordSource()): number {
    this.prune(now);
    const pair = PasswordGuard.pair(account, source);
    const tries = this.sources.get(pair);
    if (tries === undefined) return 0;
    const slowdown = this.slowdowns.get(PasswordGuard.key(account));
    // Legacy observation only: account existence never affects authentication or state retention.
    return Math.max(0, tries.lockedUntil - now, slowdown?.observedAccount === true ? slowdown.until - now : 0);
  }

  /** Reserve one password check, or return its wait. No password derivation may precede this call. */
  preflight(account: string, now: number, source: string = currentPasswordSource(), proven = false): number {
    this.prune(now);
    const tries = this.sources.get(PasswordGuard.pair(account, source));
    const key = PasswordGuard.key(account);
    const slowdown = this.slowdowns.get(key);
    const sourceWait = Math.max(0, (tries?.lockedUntil ?? 0) - now,
      tries === undefined ? 0 : (slowdown?.until ?? 0) - now);
    if (sourceWait > 0) return sourceWait;
    if (proven || slowdown === undefined || slowdown.until <= now) return 0;
    slowdown.admissions = slowdown.admissions.filter(at => at > now - ACCOUNT_PASSWORD_WINDOW_MS);
    if (slowdown.admissions.length >= ACCOUNT_PASSWORD_TRIES) {
      return slowdown.admissions[0]! + ACCOUNT_PASSWORD_WINDOW_MS - now;
    }
    slowdown.admissions.push(now);
    return 0;
  }

  /** A wrong password; only a database lookup may establish `exists`. */
  failed(account: string, now: number, source: string = currentPasswordSource(), exists = false): void {
    this.prune(now);
    const pair = PasswordGuard.pair(account, source);
    const tries = this.sources.retain(pair, () => ({ failures: 0, lockedUntil: 0, locks: 0, lastAt: now }));
    tries.failures += 1;
    tries.lastAt = now;
    this.nextPruneAt = Math.min(this.nextPruneAt, now + this.policy.maxLockMs);
    if (tries.failures >= this.policy.failuresBeforeLock) {
      const lockMs = Math.min(this.policy.maxLockMs, this.policy.firstLockMs * 2 ** tries.locks);
      tries.lockedUntil = now + lockMs;
      tries.locks += 1;
      tries.failures = 0;
      this.onLock?.(account.trim().slice(0, 64), lockMs);
    }
    const key = PasswordGuard.key(account);
    const slowdown = this.slowdowns.retain(key, () => ({ failures: 0, until: 0, lastAt: now, admissions: [], observedAccount: false }));
    slowdown.observedAccount = exists;
    slowdown.failures += 1;
    slowdown.lastAt = now;
    const over = slowdown.failures - this.policy.failuresBeforeLock;
    if (over >= 0) slowdown.until = now + Math.min(this.policy.maxLockMs, this.policy.firstSlowMs * 2 ** Math.min(over, 32));
  }

  /** The right password clears individually tracked state; shared overflow buckets must expire by time. */
  succeeded(account: string, source: string = currentPasswordSource()): void {
    const pair = PasswordGuard.pair(account, source);
    this.sources.clear(pair);
    this.slowdowns.clear(PasswordGuard.key(account));
  }

  /** Individually tracked source-and-name entries (at most TRACKED), excluding fixed shared overflow buckets. */
  get size(): number { return this.sources.size; }
}

const guards = new WeakMap<object, PasswordGuard>();
/** The guard for one database (a store): every password check against it counts. */
export function passwordGuardOf(owner: object): PasswordGuard {
  let guard = guards.get(owner);
  if (guard === undefined) { guard = new PasswordGuard(); guards.set(owner, guard); }
  return guard;
}

/**
 * Wrong passwords from one address, across every account: at most `tries`
 * in `windowMs`. What a lockout per account can't see (one address trying
 * many names) this does.
 */
export class SourceBudget {
  private readonly sources = new Map<string, number[]>();
  constructor(readonly tries = 20, readonly windowMs = 10 * 60_000) {}

  /** Milliseconds until this address may try again (0: it may). */
  waitFor(address: string, now: number): number {
    const recent = (this.sources.get(sourceKey(address)) ?? []).filter(at => now - at < this.windowMs);
    return recent.length < this.tries ? 0 : this.windowMs - (now - recent[0]!);
  }

  failed(address: string, now: number): void {
    const source = sourceKey(address);
    const recent = (this.sources.get(source) ?? []).filter(at => now - at < this.windowMs);
    recent.push(now);
    this.sources.delete(source);
    this.sources.set(source, recent.slice(-this.tries));
    while (this.sources.size > TRACKED) this.sources.delete(this.sources.keys().next().value!);
  }
}
