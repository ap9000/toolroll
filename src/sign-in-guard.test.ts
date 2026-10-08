/**
 * The password guard keys its lock by source (sign-in-guard.ts): a source that guessed wrong waits, the owner from a
 * clean source does not, rotating sources slows the account for every source that already failed (refused before the
 * password is checked), and a flood of made-up names never washes a real account's state out of the bounded table.
 */
import { expect, test } from "vitest";
import { DEFAULT_GUARD_POLICY, LOCAL_SOURCE, PasswordGuard, currentPasswordSource, withPasswordSource } from "./sign-in-guard.js";

const MINUTE = 60_000;

test("five wrong passwords lock that source only; a clean source may still try, and its right password clears the slowdown", () => {
  const guard = new PasswordGuard(), locks: [string, number][] = [];
  guard.onLock = (account, ms) => locks.push([account, ms]);
  for (let i = 0; i < 5; i++) guard.failed("alex", 0, "fwd:203.0.113.5", true);
  expect(locks).toEqual([["alex", DEFAULT_GUARD_POLICY.firstLockMs]]);
  expect(guard.lockedFor("alex", 1, "fwd:203.0.113.5")).toBe(DEFAULT_GUARD_POLICY.firstLockMs - 1);
  expect(guard.lockedFor("Alex ", 1, "fwd:203.0.113.5")).toBeGreaterThan(0);
  // The owner elsewhere, and this computer, are not locked out.
  expect(guard.lockedFor("alex", 1, "fwd:198.51.100.7")).toBe(0);
  expect(guard.lockedFor("alex", 1, LOCAL_SOURCE)).toBe(0);
  guard.succeeded("alex", "fwd:198.51.100.7");
  // The attacker's own lock stands until it runs out.
  expect(guard.lockedFor("alex", 2, "fwd:203.0.113.5")).toBeGreaterThan(0);
  expect(guard.lockedFor("alex", DEFAULT_GUARD_POLICY.firstLockMs, "fwd:203.0.113.5")).toBe(0);
});

test("rotating sources slows the account for every source that already failed, never for a clean one", () => {
  const guard = new PasswordGuard();
  for (let i = 1; i <= 4; i++) guard.failed("alex", 0, `fwd:203.0.113.${i}`, true);
  // Four wrong across sources: no slowdown yet, each source has tries left.
  expect(guard.lockedFor("alex", 1, "fwd:203.0.113.1")).toBe(0);
  guard.failed("alex", 0, "fwd:203.0.113.5", true);
  // The fifth starts it: every source that got alex wrong is held back (so refused before any password check)...
  for (let i = 1; i <= 5; i++) expect(guard.lockedFor("alex", 1, `fwd:203.0.113.${i}`)).toBe(DEFAULT_GUARD_POLICY.firstSlowMs - 1);
  // ...while a source that hasn't failed is always checked.
  expect(guard.lockedFor("alex", 1, "fwd:198.51.100.7")).toBe(0);
  // Each further wrong password (one per fresh source) doubles it.
  guard.failed("alex", MINUTE, "fwd:203.0.113.6", true);
  expect(guard.lockedFor("alex", MINUTE, "fwd:203.0.113.1")).toBe(2 * DEFAULT_GUARD_POLICY.firstSlowMs);
  guard.failed("alex", 2 * MINUTE, "fwd:203.0.113.7", true);
  expect(guard.lockedFor("alex", 2 * MINUTE, "fwd:203.0.113.1")).toBe(4 * DEFAULT_GUARD_POLICY.firstSlowMs);
  // Capped at a day however long it goes on.
  for (let i = 0; i < 40; i++) guard.failed("alex", 3 * MINUTE, `fwd:192.0.2.${i}`, true);
  expect(guard.lockedFor("alex", 3 * MINUTE, "fwd:203.0.113.1")).toBe(DEFAULT_GUARD_POLICY.maxLockMs);
  // The owner signs in from a clean source: the slowdown ends; the attackers' sources keep only their own counts.
  guard.succeeded("alex", "fwd:198.51.100.7");
  expect(guard.lockedFor("alex", 3 * MINUTE, "fwd:203.0.113.1")).toBe(0);
});

test("a name that isn't an account is locked per source like any other, but never slowed down across sources", () => {
  const guard = new PasswordGuard();
  for (let i = 1; i <= 10; i++) guard.failed("nobody", 0, `fwd:203.0.113.${i}`, false);
  expect(guard.lockedFor("nobody", 1, "fwd:203.0.113.1")).toBe(0);
  for (let i = 0; i < 4; i++) guard.failed("nobody", 0, "fwd:203.0.113.1", false);
  expect(guard.lockedFor("nobody", 1, "fwd:203.0.113.1")).toBe(DEFAULT_GUARD_POLICY.firstLockMs - 1);
});

test("flooding the table with made-up names never evicts a real account's lock or slowdown", () => {
  const guard = new PasswordGuard();
  for (let i = 0; i < 5; i++) guard.failed("alex", 0, "fwd:203.0.113.5", true);
  for (let i = 1; i <= 4; i++) guard.failed("sam", 0, `fwd:198.51.100.${i}`, true);
  guard.failed("sam", 0, "fwd:198.51.100.9", true);
  for (let i = 0; i < 25_000; i++) guard.failed(`made-up-${i}`, 1, `fwd:192.0.2.${i % 250}`, false);
  expect(guard.size).toBeLessThanOrEqual(10_000);
  expect(guard.lockedFor("alex", 2, "fwd:203.0.113.5")).toBeGreaterThan(0);
  expect(guard.lockedFor("sam", 2, "fwd:198.51.100.1")).toBeGreaterThan(0);
  // The newest made-up names are still tracked; the oldest went first.
  for (let i = 0; i < 4; i++) guard.failed("made-up-24999", 3, "fwd:192.0.2.249", false);
  expect(guard.lockedFor("made-up-24999", 4, "fwd:192.0.2.249")).toBeGreaterThan(0);
});

test("a check outside any request counts as this computer, as does a request from this computer", () => {
  expect(currentPasswordSource()).toBe(LOCAL_SOURCE);
  expect(withPasswordSource("fwd:203.0.113.5", () => currentPasswordSource())).toBe("fwd:203.0.113.5");
  const guard = new PasswordGuard();
  for (let i = 0; i < 5; i++) guard.failed("alex", 0, "127.0.0.1", true);
  expect(guard.lockedFor("alex", 1)).toBeGreaterThan(0);
  expect(guard.lockedFor("alex", 1, "::1")).toBeGreaterThan(0);
  expect(withPasswordSource("fwd:203.0.113.5", () => guard.lockedFor("alex", 1))).toBe(0);
});
