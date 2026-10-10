/**
 * Request budgets for person API tokens (v112): how many requests one `so_` token may make across all accepting routes.
 * One budget per token, keyed by its credential row id (a person's API token, v118) (never the secret, its name or an address), shared by those
 * routes. A read token gets 120 requests in any sliding minute, an act token 30, and either 10,000 in a rolling day;
 * an instance operator may override any of these for the installation or for one token in the console (step-up).
 *
 * The token's saved access decides its class: nothing in a request body moves it. A request is counted once when it
 * is admitted, however long it then holds the server (a task wait long-poll is one request, not one per second).
 * Over budget answers 429 with Retry-After; the first refusal in each exhausted window is ledgered, never each one.
 *
 * Tracking is in memory and bounded: at most TRACKED_TOKENS tokens (least recently used goes first, saved before it
 * goes), each with at most PER_MINUTE_MAX request times and one counter per minute of the day. It is saved every
 * FLUSH_MS, on eviction, on server close and at once on a refusal, so a restart doesn't hand a client hammering the
 * server a fresh budget. Anything unreadable (a policy or saved usage outside its bounds) refuses: fail closed.
 */
import type { Database, Store } from "./store.js";
import type { TokenAccess } from "./api-tokens.js";
import { sourceKey } from "./source-key.js";

export const REQUEST_BUDGET_SCHEMA = `
CREATE TABLE IF NOT EXISTS request_budget_limit (
  target          TEXT PRIMARY KEY CHECK (target = '*' OR (length(target) = 12 AND target NOT GLOB '*[^0-9a-f]*')),
  read_per_minute INTEGER CHECK (read_per_minute IS NULL OR read_per_minute BETWEEN 1 AND 600),
  act_per_minute  INTEGER CHECK (act_per_minute IS NULL OR act_per_minute BETWEEN 1 AND 600),
  per_day         INTEGER CHECK (per_day IS NULL OR per_day BETWEEN 1 AND 100000),
  set_by          TEXT NOT NULL,
  set_at          TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS request_budget_usage (
  token_id  TEXT PRIMARY KEY,
  minute    TEXT NOT NULL,
  day       TEXT NOT NULL,
  noted     TEXT NOT NULL,
  saved_at  INTEGER NOT NULL
);
`;

export const REQUEST_BUDGET_DEFAULTS = Object.freeze({ read: 120, act: 30, day: 10_000 });
export const PER_MINUTE_MAX = 600;
export const PER_DAY_MAX = 100_000;
export const TRACKED_TOKENS = 1024;
export const FLUSH_MS = 5_000;
const MINUTE = 60_000, DAY = 86_400_000;

/** Which limit a refusal hit: the body of a 429 names only this and Retry-After. */
export type BudgetLimit = "read-per-minute" | "act-per-minute" | "per-day" | "per-minute";
export type Admission =
  | { ok: true }
  | { ok: false; status: 429; limit: BudgetLimit; retryAfter: number }
  | { ok: false; status: 503 };
export type BudgetRoute = "api" | "mcp";

/** An override: null leaves that limit to the installation (for a token) or the default. */
export type LimitOverride = { readPerMinute: number | null; actPerMinute: number | null; perDay: number | null };
export type EffectiveLimits = { perMinute: number; perDay: number; overridden: boolean };

/** The words for a 429, in one line. */
export const limitWords = (limit: BudgetLimit, retryAfter: number): string =>
  `Request limit reached (${limit === "per-day" ? "requests per day" : limit === "read-per-minute" ? "read requests per minute" : limit === "act-per-minute" ? "act requests per minute" : "requests per minute"}). Try again in ${retryAfter} second${retryAfter === 1 ? "" : "s"}.`;

/** A limit typed into a form: a whole number within bounds, "" for none, or a problem. */
export function parseLimit(raw: string, max: number): number | null | { problem: string } {
  const text = raw.trim();
  if (text === "") return null;
  if (!/^[0-9]{1,6}$/.test(text)) return { problem: `Limits are whole numbers from 1 to ${max.toLocaleString("en-US")}.` };
  const value = Number(text);
  return value >= 1 && value <= max ? value : { problem: `Limits are whole numbers from 1 to ${max.toLocaleString("en-US")}.` };
}

const within = (value: unknown, max: number): number | null => {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error("request budget: a saved limit is out of bounds");
  return n;
};

function readOverride(db: Database, target: string): LimitOverride | null {
  const row = db.prepare("SELECT read_per_minute, act_per_minute, per_day FROM request_budget_limit WHERE target = ?").get(target);
  if (row === undefined) return null;
  return { readPerMinute: within(row["read_per_minute"], PER_MINUTE_MAX), actPerMinute: within(row["act_per_minute"], PER_MINUTE_MAX), perDay: within(row["per_day"], PER_DAY_MAX) };
}

/** Every override: the installation's under "*", each token's under its id. */
export function limitOverrides(db: Database): Map<string, LimitOverride> {
  const out = new Map<string, LimitOverride>();
  for (const row of db.prepare("SELECT target FROM request_budget_limit ORDER BY target").all()) {
    const target = String(row["target"]);
    out.set(target, readOverride(db, target)!);
  }
  return out;
}

/** Token override, then the installation's, then the default — per limit. */
export function effectiveLimits(db: Database, tokenId: string, access: TokenAccess): EffectiveLimits {
  const token = readOverride(db, tokenId), installation = readOverride(db, "*");
  const pick = (of: (one: LimitOverride) => number | null, fallback: number) => (token === null ? null : of(token)) ?? (installation === null ? null : of(installation)) ?? fallback;
  const minute = (one: LimitOverride) => access === "read" ? one.readPerMinute : one.actPerMinute;
  const perMinute = pick(minute, REQUEST_BUDGET_DEFAULTS[access]), perDay = pick(one => one.perDay, REQUEST_BUDGET_DEFAULTS.day);
  return { perMinute, perDay, overridden: perMinute !== REQUEST_BUDGET_DEFAULTS[access] || perDay !== REQUEST_BUDGET_DEFAULTS.day };
}

/** Set (or, all null, clear) an override, with the change in the policy ledger. The caller checks who may. */
export function setLimitOverride(store: Store, target: string, next: LimitOverride, by: string, now: Date): { before: LimitOverride | null; after: LimitOverride | null } {
  const db = store.handle;
  if (target !== "*" && !/^[0-9a-f]{12}$/.test(target)) throw new Error("request budget: unknown target");
  within(next.readPerMinute, PER_MINUTE_MAX); within(next.actPerMinute, PER_MINUTE_MAX); within(next.perDay, PER_DAY_MAX);
  const before = readOverride(db, target);
  const cleared = next.readPerMinute === null && next.actPerMinute === null && next.perDay === null;
  if (cleared) db.prepare("DELETE FROM request_budget_limit WHERE target = ?").run(target);
  else db.prepare(`INSERT INTO request_budget_limit (target, read_per_minute, act_per_minute, per_day, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(target) DO UPDATE SET read_per_minute = excluded.read_per_minute, act_per_minute = excluded.act_per_minute, per_day = excluded.per_day, set_by = excluded.set_by, set_at = excluded.set_at`)
    .run(target, next.readPerMinute, next.actPerMinute, next.perDay, by, now.toISOString());
  const after = cleared ? null : next;
  const words = (one: LimitOverride | null) => one === null ? "defaults" : [one.readPerMinute === null ? null : `read ${one.readPerMinute}/min`, one.actPerMinute === null ? null : `act ${one.actPerMinute}/min`, one.perDay === null ? null : `${one.perDay}/day`].filter(Boolean).join(", ");
  const name = target === "*" ? "installation" : `token ${store.apiTokenSecret(target)?.row.name ?? target}`;
  store.recordAction({ at: now.toISOString(), actor: by, repo: null, taskId: null, runId: null, action: "request limits changed", outcome: "changed", source: "policy", detail: `${name}: ${words(before)} → ${words(after)}` });
  return { before, after };
}

type Usage = {
  /** Accepted request times (ms) still inside the last minute, oldest first; at most PER_MINUTE_MAX. */
  minute: number[];
  /** Accepted requests per minute index (ms / 60,000) inside the last day; at most one per minute of the day. */
  day: Map<number, number>;
  /** Until when each exhausted window has already been ledgered (ms; 0: not exhausted). */
  noted: { minute: number; day: number };
  dirty: boolean;
};

const finiteInts = (value: unknown, max: number): value is number[] => Array.isArray(value) && value.length <= max && value.every(one => Number.isSafeInteger(one) && one >= 0);

function prune(usage: Usage, now: number): void {
  let drop = 0;
  while (drop < usage.minute.length && usage.minute[drop]! <= now - MINUTE) drop++;
  if (drop > 0) { usage.minute.splice(0, drop); usage.dirty = true; }
  for (const at of usage.day.keys()) if ((at + 1) * MINUTE + DAY <= now) { usage.day.delete(at); usage.dirty = true; }
}

export type RequestBudgetOptions = {
  store: Store;
  /** Milliseconds since the epoch; tests inject their own. */
  clock?: () => number;
  tracked?: number;
  flushMs?: number;
};

/** One per server: both routes share it, so a token's allowance is never doubled. */
export class RequestBudget {
  private readonly store: Store;
  private readonly clock: () => number;
  private readonly tracked: number;
  private readonly flushMs: number;
  private readonly usage = new Map<string, Usage>();
  private lastFlush: number;

  constructor(options: RequestBudgetOptions) {
    this.store = options.store;
    this.clock = options.clock ?? Date.now;
    this.tracked = Math.max(1, options.tracked ?? TRACKED_TOKENS);
    this.flushMs = options.flushMs ?? FLUSH_MS;
    this.lastFlush = this.clock();
  }

  /** How many tokens are tracked in memory now (never more than `tracked`). */
  get size(): number { return this.usage.size; }

  /**
   * Admit one request by an authenticated token, or say why not. Called once per HTTP request, before its body is
   * read. Anything unreadable refuses with 503 and nothing runs.
   */
  admit(tokenId: string, route: BudgetRoute): Admission {
    const result = this.check(tokenId, route);
    if (!result.ok) this.store.telemetry.budgetRefused(route, result.status === 429 ? result.limit : 'unavailable');
    return result;
  }

  private check(tokenId: string, route: BudgetRoute): Admission {
    try {
      const now = this.clock();
      const token = this.store.apiTokenSecret(tokenId)?.row;
      if (token === undefined) return { ok: false, status: 503 };
      const limits = effectiveLimits(this.store.handle, token.id, token.access);
      const usage = this.load(token.id, now);
      prune(usage, now);
      let wait = 0, limit: BudgetLimit | null = null;
      if (usage.minute.length >= limits.perMinute) {
        wait = usage.minute[usage.minute.length - limits.perMinute]! + MINUTE - now;
        limit = token.access === "read" ? "read-per-minute" : "act-per-minute";
      }
      let total = 0;
      for (const count of usage.day.values()) total += count;
      if (total >= limits.perDay) {
        let freed = 0;
        for (const at of [...usage.day.keys()].sort((a, b) => a - b)) {
          freed += usage.day.get(at)!;
          if (total - freed < limits.perDay) {
            const until = (at + 1) * MINUTE + DAY - now;
            if (until > wait || limit === null) { wait = until; limit = "per-day"; }
            break;
          }
        }
      }
      if (limit !== null) {
        const retryAfter = Math.max(1, Math.ceil(wait / 1000));
        const window = limit === "per-day" ? "day" : "minute";
        // Once per exhausted window: the marker lasts until the window has room again, and is saved with the entry.
        if (usage.noted[window] <= now) {
          usage.noted[window] = now + retryAfter * 1000;
          usage.dirty = true;
          this.save(token.id, usage, now);
          this.store.recordAction({ at: new Date(now).toISOString(), actor: token.account, repo: null, taskId: null, runId: null, action: "remote request limit reached", outcome: "refused", source: route, detail: `token ${token.name}: ${limit}` });
        }
        return { ok: false, status: 429, limit, retryAfter };
      }
      usage.minute.push(now);
      if (usage.minute.length > PER_MINUTE_MAX) usage.minute.splice(0, usage.minute.length - PER_MINUTE_MAX);
      const at = Math.floor(now / MINUTE);
      usage.day.set(at, (usage.day.get(at) ?? 0) + 1);
      usage.dirty = true;
      if (now - this.lastFlush >= this.flushMs) this.flush();
      return { ok: true };
    } catch {
      return { ok: false, status: 503 };
    }
  }

  /** Save every changed entry. A server calls this on a timer and when it closes. */
  flush(): void {
    const now = this.clock();
    this.lastFlush = now;
    for (const [id, usage] of this.usage) if (usage.dirty) this.save(id, usage, now);
    // Saved rows whose every count has expired are no use to anyone.
    this.store.handle.prepare("DELETE FROM request_budget_usage WHERE saved_at <= ?").run(now - DAY - MINUTE);
  }

  private save(id: string, usage: Usage, now: number): void {
    this.store.handle.prepare(`INSERT INTO request_budget_usage (token_id, minute, day, noted, saved_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(token_id) DO UPDATE SET minute = excluded.minute, day = excluded.day, noted = excluded.noted, saved_at = excluded.saved_at`)
      .run(id, JSON.stringify(usage.minute), JSON.stringify([...usage.day]), JSON.stringify(usage.noted), now);
    usage.dirty = false;
  }

  /** The tracked entry (now the most recently used), from memory or as last saved; the least recently used is saved and let go. */
  private load(id: string, now: number): Usage {
    let usage = this.usage.get(id);
    if (usage !== undefined) { this.usage.delete(id); this.usage.set(id, usage); return usage; }
    const row = this.store.handle.prepare("SELECT minute, day, noted FROM request_budget_usage WHERE token_id = ?").get(id);
    if (row === undefined) usage = { minute: [], day: new Map(), noted: { minute: 0, day: 0 }, dirty: false };
    else {
      const minute: unknown = JSON.parse(String(row["minute"])), day: unknown = JSON.parse(String(row["day"])), noted: unknown = JSON.parse(String(row["noted"]));
      if (!finiteInts(minute, PER_MINUTE_MAX) || !Array.isArray(day) || day.length > 2 * DAY / MINUTE || !day.every(pair => finiteInts(pair, 2) && pair.length === 2)
        || noted === null || typeof noted !== "object" || !finiteInts([(noted as Record<string, unknown>)["minute"], (noted as Record<string, unknown>)["day"]], 2)) {
        throw new Error("request budget: saved usage is unreadable");
      }
      const kept = noted as { minute: number; day: number };
      usage = { minute: [...minute].sort((a, b) => a - b), day: new Map(day as [number, number][]), noted: { minute: kept.minute, day: kept.day }, dirty: false };
    }
    this.usage.set(id, usage);
    while (this.usage.size > this.tracked) {
      const [oldest, entry] = this.usage.entries().next().value as [string, Usage];
      if (entry.dirty) this.save(oldest, entry, now);
      this.usage.delete(oldest);
    }
    return usage;
  }
}

/** Per-minute allowances for non-person-token identities and unauthenticated ingress. Password accounts get room
 * for two-second follower polling plus ordinary commands; OAuth exchanges stay keyed by source address. */
export const SOURCE_BUDGET_DEFAULTS = Object.freeze({ password: 120, oauthToken: 30, coordinator: 120, teamsSource: 120, teamsTenant: 600 });

/**
 * A sliding minute per source or proved account, with bounded in-memory LRU history. Expired entries are
 * pruned first; at capacity the least recently used entry is evicted so new callers are never globally locked out.
 * Unverified account names must never be keys. Person API tokens use the persisted RequestBudget above. An address
 * key counts by sourceKey (a native IPv6 caller by its /64). Verified identities must explicitly use exact keys.
 */
export class SourceAdmission {
  private readonly perMinute: number;
  private readonly clock: () => number;
  private readonly tracked: number;
  private readonly usage = new Map<string, number[]>();
  private readonly keyMode: "source" | "exact";

  constructor(options: { perMinute: number; clock?: () => number; tracked?: number; keyMode?: "source" | "exact" }) {
    this.keyMode = options.keyMode ?? "source";
    this.perMinute = Math.max(1, Math.min(PER_MINUTE_MAX, options.perMinute));
    this.clock = options.clock ?? Date.now;
    this.tracked = Math.max(1, options.tracked ?? TRACKED_TOKENS);
  }

  get size(): number { return this.usage.size; }

  admit(key: string): Admission {
    const now = this.clock(), source = this.keyMode === "exact" ? key : sourceKey(key);
    let times = this.usage.get(source);
    if (times === undefined) {
      if (this.usage.size >= this.tracked) {
        for (const [key, kept] of this.usage) if (kept.every(at => at <= now - MINUTE)) this.usage.delete(key);
        if (this.usage.size >= this.tracked) this.usage.delete(this.usage.keys().next().value!);
      }
      times = [];
    }
    this.usage.delete(source);
    this.usage.set(source, times);
    while (times.length > 0 && times[0]! <= now - MINUTE) times.shift();
    if (times.length >= this.perMinute) {
      return { ok: false, status: 429, limit: "per-minute", retryAfter: Math.max(1, Math.ceil((times[times.length - this.perMinute]! + MINUTE - now) / 1000)) };
    }
    times.push(now);
    return { ok: true };
  }
}
