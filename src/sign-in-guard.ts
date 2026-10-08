import { AsyncLocalStorage } from "node:async_hooks";
import { sourceKey } from "./source-key.js";

/**
 * Password guessing (v99). Five wrong passwords in a row for one account from one source lock that account for that
 * source for 15 minutes, doubling with each further lock up to a day; a right one clears the count. Every password
 * check counts: signing in, a request that carries a password, and each step-up inside the console. Unknown names
 * count too, so guessing names gains nothing.
 *
 * A source is where the request came from (serve.ts's joinSourceOf, a native IPv6 caller by its /64); anything not
 * answering a request (the CLI on this computer) is LOCAL_SOURCE, as is a request from this computer itself. Someone
 * who knows a name can lock only their own source out, never its owner elsewhere. Across sources, wrong passwords for
 * an account that exists slow it down: from the fifth on, each holds back every source that has already got that
 * account wrong, for a minute doubling up to a day. A source that hasn't failed is always checked, so the owner's
 * right password still works; someone rotating sources gets one guess per fresh source while the slowdown runs, and
 * a held-back source is refused before its password is checked, so it costs the server no key derivation.
 *
 * Kept in memory, per database, bounded: a restart forgives. Made-up names are let go before any real account's
 * state, so flooding the table with them can't wash out a lock. The console reports each lock to the action ledger
 * through onLock.
 */
export type GuardPolicy = { failuresBeforeLock: number; firstLockMs: number; maxLockMs: number; firstSlowMs: number };
export const DEFAULT_GUARD_POLICY: GuardPolicy = { failuresBeforeLock: 5, firstLockMs: 15 * 60_000, maxLockMs: 24 * 60 * 60_000, firstSlowMs: 60_000 };
const TRACKED = 10_000;
/** The source of a password checked outside any request, and of a request from this computer. */
export const LOCAL_SOURCE = "local";
const LOCAL_PEERS: ReadonlySet<string> = new Set(["127.0.0.1", "::1"]);

const passwordSource = new AsyncLocalStorage<string>();
/** Run `work` with every password check inside it counted against `source`. */
export const withPasswordSource = <T>(source: string, work: () => T): T => passwordSource.run(source, work);
/** Where the password being checked now came from (LOCAL_SOURCE outside a request). */
export const currentPasswordSource = (): string => passwordSource.getStore() ?? LOCAL_SOURCE;

type Tries = { failures: number; lockedUntil: number; locks: number };
type Slowdown = { failures: number; until: number; lastAt: number };

export class PasswordGuard {
  /** Per source and account that exists. */
  private readonly accounts = new Map<string, Tries>();
  /** Per source and name that doesn't: let go first. */
  private readonly guesses = new Map<string, Tries>();
  /** Per account that exists, across sources. */
  private readonly slowdowns = new Map<string, Slowdown>();
  /** Told once per lock: the account (as typed), and for how long. */
  onLock: ((account: string, lockMs: number) => void) | null = null;
  constructor(readonly policy: GuardPolicy = DEFAULT_GUARD_POLICY) {}

  private static key(account: string): string { return account.trim().toLowerCase().slice(0, 64); }
  private static pair(account: string, source: string): string {
    const key = sourceKey(source);
    return `${LOCAL_PEERS.has(key) ? LOCAL_SOURCE : key}\u0000${PasswordGuard.key(account)}`;
  }

  /** Milliseconds this account stays locked for this source (0: it may try). */
  lockedFor(account: string, now: number, source: string = currentPasswordSource()): number {
    const pair = PasswordGuard.pair(account, source);
    const tries = this.accounts.get(pair) ?? this.guesses.get(pair);
    if (tries === undefined) return 0;
    const slowdown = this.slowdowns.get(PasswordGuard.key(account));
    return Math.max(0, tries.lockedUntil - now, slowdown === undefined ? 0 : slowdown.until - now);
  }

  /** A wrong password; `exists` when the name is a real account (only those are slowed down across sources). */
  failed(account: string, now: number, source: string = currentPasswordSource(), exists = false): void {
    const pair = PasswordGuard.pair(account, source);
    const tries = this.accounts.get(pair) ?? this.guesses.get(pair) ?? { failures: 0, lockedUntil: 0, locks: 0 };
    this.accounts.delete(pair);
    this.guesses.delete(pair);
    tries.failures += 1;
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
    if (!exists) return;
    const key = PasswordGuard.key(account);
    const kept = this.slowdowns.get(key);
    const slowdown = kept === undefined || now - kept.lastAt > this.policy.maxLockMs ? { failures: 0, until: 0, lastAt: now } : kept;
    this.slowdowns.delete(key);
    slowdown.failures += 1;
    slowdown.lastAt = now;
    const over = slowdown.failures - this.policy.failuresBeforeLock;
    if (over >= 0) slowdown.until = now + Math.min(this.policy.maxLockMs, this.policy.firstSlowMs * 2 ** Math.min(over, 32));
    this.slowdowns.set(key, slowdown);
    while (this.slowdowns.size > TRACKED) this.slowdowns.delete(this.slowdowns.keys().next().value!);
  }

  /** The right password: this source's count clears, and so does the account's slowdown. */
  succeeded(account: string, source: string = currentPasswordSource()): void {
    const pair = PasswordGuard.pair(account, source);
    this.accounts.delete(pair);
    this.guesses.delete(pair);
    this.slowdowns.delete(PasswordGuard.key(account));
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
