/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { mintApiToken } from "./api-tokens.js";
import { addApprover } from "./scope.js";
import { effectiveLimits, parseLimit, RequestBudget, REQUEST_BUDGET_DEFAULTS, setLimitOverride, type Admission } from "./request-budget.js";

const T0 = Date.parse("2026-10-06T12:00:00.000Z");
let dir: string, file: string, store: Store, now: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-request-budget-"));
  file = join(dir, "state.db");
  store = openStore(file);
  now = T0;
  if (!addApprover(store, "sam", new Date(T0)).ok) throw new Error("sam");
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const token = (access: "read" | "act", name = `${access}-laptop`, account = "sam"): string => {
  const minted = mintApiToken();
  store.createApiToken({ id: minted.id, account, name, secretHash: minted.hash, access, expiresAt: new Date(T0 + 30 * 86_400_000).toISOString(), by: account }, new Date(T0));
  return minted.id;
};
const budget = (options: { tracked?: number } = {}) => new RequestBudget({ store, clock: () => now, ...options });
const times = (n: number, run: () => Admission): Admission[] => Array.from({ length: n }, run);
const limitRows = () => store.actionLedger({ repos: null, limit: 100 }).filter(one => one.action === "remote request limit reached");

test("steady use passes: a read token at one request a second for ten minutes is never refused", () => {
  const id = token("read"), limits = budget();
  for (let second = 0; second < 600; second++) { now = T0 + second * 1000; expect(limits.admit(id, "api")).toEqual({ ok: true }); }
  expect(limitRows()).toEqual([]);
});

test("a burst gets 429 with Retry-After at the read limit, and an act token's limit is lower", () => {
  const read = token("read"), act = token("act"), limits = budget();
  expect(times(REQUEST_BUDGET_DEFAULTS.read, () => limits.admit(read, "api")).every(one => one.ok)).toBe(true);
  expect(limits.admit(read, "api")).toEqual({ ok: false, status: 429, limit: "read-per-minute", retryAfter: 60 });
  expect(times(REQUEST_BUDGET_DEFAULTS.act, () => limits.admit(act, "mcp")).every(one => one.ok)).toBe(true);
  expect(limits.admit(act, "mcp")).toEqual({ ok: false, status: 429, limit: "act-per-minute", retryAfter: 60 });
  expect(REQUEST_BUDGET_DEFAULTS.act).toBeLessThan(REQUEST_BUDGET_DEFAULTS.read);
});

test("the window slides: Retry-After counts down to the oldest request leaving, and then there is room again", () => {
  const id = token("act"), limits = budget();
  for (let i = 0; i < 30; i++) { now = T0 + i * 1000; expect(limits.admit(id, "api").ok).toBe(true); }
  now = T0 + 30_000;
  expect(limits.admit(id, "api")).toMatchObject({ status: 429, retryAfter: 30 });
  now = T0 + 59_999;
  expect(limits.admit(id, "api")).toMatchObject({ status: 429, retryAfter: 1 });
  now = T0 + 60_000;
  expect(limits.admit(id, "api")).toEqual({ ok: true });
  expect(limits.admit(id, "api")).toMatchObject({ status: 429, retryAfter: 1 });
});

test("the daily cap counts per minute and refuses with the time until a minute's requests leave the day", () => {
  const id = token("read"), limits = budget();
  setLimitOverride(store, id, { readPerMinute: null, actPerMinute: null, perDay: 50 }, "alex", new Date(T0));
  for (let minute = 0; minute < 5; minute++) { now = T0 + minute * 60_000; expect(times(10, () => limits.admit(id, "api")).every(one => one.ok)).toBe(true); }
  now = T0 + 10 * 60_000;
  expect(limits.admit(id, "api")).toEqual({ ok: false, status: 429, limit: "per-day", retryAfter: 86_400 - 9 * 60 });
  now = T0 + 86_400_000 + 60_000;
  expect(limits.admit(id, "api")).toEqual({ ok: true });
});

test("an override applies: the installation's, then a token's own, and clearing goes back to the defaults", () => {
  const first = token("read", "first"), second = token("read", "second"), limits = budget();
  setLimitOverride(store, "*", { readPerMinute: 5, actPerMinute: null, perDay: null }, "alex", new Date(T0));
  setLimitOverride(store, second, { readPerMinute: 2, actPerMinute: null, perDay: null }, "alex", new Date(T0));
  expect(effectiveLimits(store.handle, first, "read")).toEqual({ perMinute: 5, perDay: REQUEST_BUDGET_DEFAULTS.day, overridden: true });
  expect(times(5, () => limits.admit(first, "api")).every(one => one.ok)).toBe(true);
  expect(limits.admit(first, "api")).toMatchObject({ status: 429, limit: "read-per-minute" });
  expect(times(2, () => limits.admit(second, "api")).every(one => one.ok)).toBe(true);
  expect(limits.admit(second, "api")).toMatchObject({ status: 429 });
  setLimitOverride(store, "*", { readPerMinute: null, actPerMinute: null, perDay: null }, "alex", new Date(T0));
  setLimitOverride(store, second, { readPerMinute: null, actPerMinute: null, perDay: null }, "alex", new Date(T0));
  expect(effectiveLimits(store.handle, second, "read")).toEqual({ perMinute: REQUEST_BUDGET_DEFAULTS.read, perDay: REQUEST_BUDGET_DEFAULTS.day, overridden: false });
  expect(limits.admit(first, "api")).toEqual({ ok: true });
  // Every change is in the policy history, by name, with no secret.
  expect(store.actionLedger({ repos: null, source: "policy", limit: 10 }).map(one => one.detail)).toEqual([
    "token second: read 2/min → defaults", "installation: read 5/min → defaults", "token second: defaults → read 2/min", "installation: defaults → read 5/min"]);
});

test("limits are bounded: out-of-range overrides are refused by the form, the module and the table", () => {
  expect(parseLimit("", 600)).toBeNull();
  expect(parseLimit(" 30 ", 600)).toBe(30);
  for (const raw of ["0", "601", "1.5", "-1", "1e3", "abc"]) expect(parseLimit(raw, 600)).toHaveProperty("problem");
  expect(() => setLimitOverride(store, "*", { readPerMinute: 601, actPerMinute: null, perDay: null }, "alex", new Date(T0))).toThrow();
  expect(() => setLimitOverride(store, "not-a-token", { readPerMinute: 1, actPerMinute: null, perDay: null }, "alex", new Date(T0))).toThrow();
  expect(() => store.handle.prepare("INSERT INTO request_budget_limit (target, per_day, set_by, set_at) VALUES ('*', 0, 'x', 'y')").run()).toThrow(/CHECK/);
});

test("exhaustion is ledgered once per window per token, from either route, never once per request", () => {
  const id = token("act", "agent"), limits = budget();
  times(30, () => limits.admit(id, "api"));
  times(10, () => limits.admit(id, "api"));
  times(10, () => limits.admit(id, "mcp"));
  expect(limitRows()).toEqual([expect.objectContaining({ actor: "sam", outcome: "refused", source: "api", detail: "token agent: act-per-minute" })]);
  // A restart keeps the marker: still one row.
  limits.flush();
  times(5, () => budget().admit(id, "mcp"));
  expect(limitRows()).toHaveLength(1);
  // The next exhausted window is a new row.
  now = T0 + 60_000;
  times(31, () => limits.admit(id, "mcp"));
  expect(limitRows()).toHaveLength(2);
  expect(JSON.stringify(limitRows())).not.toMatch(/so_/);
});

test("a restart doesn't reset a client hammering the server: saved usage is restored on the next open", () => {
  const id = token("act"), limits = budget();
  times(30, () => limits.admit(id, "api"));
  // The tail since the last save is saved on close (serve.ts flushes on close and on a timer).
  limits.flush();
  store.close();
  store = openStore(file);
  const after = budget();
  expect(after.admit(id, "api")).toMatchObject({ status: 429, limit: "act-per-minute" });
  now = T0 + 60_000;
  expect(after.admit(id, "api")).toEqual({ ok: true });
});

test("memory is bounded: the least recently used token is saved and let go, then restored as it was", () => {
  const ids = [token("act", "one"), token("act", "two"), token("act", "three")], limits = budget({ tracked: 2 });
  times(30, () => limits.admit(ids[0]!, "api"));
  limits.admit(ids[1]!, "api");
  limits.admit(ids[2]!, "api");
  expect(limits.size).toBe(2);
  expect(limits.admit(ids[0]!, "api")).toMatchObject({ status: 429 });
  expect(limits.size).toBe(2);
});

test("fail closed: an unknown token or unreadable saved usage refuses, and nothing is admitted", () => {
  const id = token("read"), limits = budget();
  expect(limits.admit("000000000000", "api")).toEqual({ ok: false, status: 503 });
  store.handle.prepare("INSERT INTO request_budget_usage (token_id, minute, day, noted, saved_at) VALUES (?, '[\"x\"]', '[]', '{\"minute\":0,\"day\":0}', 0)").run(id);
  expect(budget().admit(id, "api")).toEqual({ ok: false, status: 503 });
  store.handle.prepare("UPDATE request_budget_usage SET minute = '[]' WHERE token_id = ?").run(id);
  expect(budget().admit(id, "api")).toEqual({ ok: true });
});
