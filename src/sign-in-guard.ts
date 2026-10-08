import { AsyncLocalStorage } from "node:async_hooks";
import { sourceKey } from "./source-key.js";

/**
 * Five failures lock a source/account pair, with exponential backoff. Across sources, failures slow an account and
 * admit only a few unproven checks per minute before password derivation. A validated same-account browser session
 * bypasses that shared admission budget, never a source's own lock. Fabricated names follow the same admission path.
 * Source records expire by time and have a capacity bound; fabricated entries are evicted first. Real account
 * slowdowns are separate, bounded by the database's accounts, so source/name churn cannot reset their budgets.
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
type Slowdown = { failures: number; until: number; lastAt: number; admissions: number[] };

export class PasswordGuard {
  /** Per source and account that exists. */
  private readonly accounts = new Map<string, Tries>();
  /** Per source and name that doesn't: let go first. */
  private readonly guesses = new Map<string, Tries>();
  /** Per account that exists, across sources. */
  private readonly slowdowns = new Map<string, Slowdown>();
  /** Disposable look-alike state: cannot evict a real account's shared budget. */
  private readonly guessedSlowdowns = new Map<string, Slowdown>();
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
    this.nextPruneAt = Infinity;
    for (const entries of [this.accounts, this.guesses, this.slowdowns, this.guessedSlowdowns]) {
      for (const [key, entry] of entries) {
        const expires = entry.lastAt + this.policy.maxLockMs;
        if (expires <= now) entries.delete(key);
        else this.nextPruneAt = Math.min(this.nextPruneAt, expires);
      }
    }
  }

  /** Source-local snapshot for existing callers. Authentication must use preflight to spend the shared budget. */
  lockedFor(account: string, now: number, source: string = currentPasswordSource()): number {
    this.prune(now);
    const pair = PasswordGuard.pair(account, source);
    const tries = this.accounts.get(pair) ?? this.guesses.get(pair);
    if (tries === undefined) return 0;
    const slowdown = this.slowdowns.get(PasswordGuard.key(account));
    return Math.max(0, tries.lockedUntil - now, slowdown === undefined ? 0 : slowdown.until - now);
  }

  /** Reserve one password check, or return its wait. No password derivation may precede this call. */
  preflight(account: string, now: number, source: string = currentPasswordSource(), proven = false): number {
    this.prune(now);
    const tries = this.accounts.get(PasswordGuard.pair(account, source)) ?? this.guesses.get(PasswordGuard.pair(account, source));
    const key = PasswordGuard.key(account);
    const slowdown = this.slowdowns.get(key) ?? this.guessedSlowdowns.get(key);
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
    const tries = this.accounts.get(pair) ?? this.guesses.get(pair) ?? { failures: 0, lockedUntil: 0, locks: 0, lastAt: now };
    this.accounts.delete(pair);
    this.guesses.delete(pair);
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
    (exists ? this.accounts : this.guesses).set(pair, tries);
    // Bounded: made-up names go first, then the oldest tracked.
    while (this.accounts.size + this.guesses.size > TRACKED) {
      const from = this.guesses.size > 0 ? this.guesses : this.accounts;
      from.delete(from.keys().next().value!);
    }
    const key = PasswordGuard.key(account);
    const slowdowns = exists ? this.slowdowns : this.guessedSlowdowns;
    const kept = slowdowns.get(key);
    const slowdown = kept === undefined || now - kept.lastAt > this.policy.maxLockMs ? { failures: 0, until: 0, lastAt: now, admissions: [] } : kept;
    slowdowns.delete(key);
    slowdown.failures += 1;
    slowdown.lastAt = now;
    const over = slowdown.failures - this.policy.failuresBeforeLock;
    if (over >= 0) slowdown.until = now + Math.min(this.policy.maxLockMs, this.policy.firstSlowMs * 2 ** Math.min(over, 32));
    slowdowns.set(key, slowdown);
    while (this.guessedSlowdowns.size > TRACKED) this.guessedSlowdowns.delete(this.guessedSlowdowns.keys().next().value!);
  }

  /** The right password: this source's count clears, and so does the account's slowdown. */
  succeeded(account: string, source: string = currentPasswordSource()): void {
    const pair = PasswordGuard.pair(account, source);
    this.accounts.delete(pair);
    this.guesses.delete(pair);
    this.slowdowns.delete(PasswordGuard.key(account));
    this.guessedSlowdowns.delete(PasswordGuard.key(account));
  }

  /** How many source-and-name entries are tracked now (never more than the bound). */
  get size(): number { return this.accounts.size + this.guesses.size; }
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
