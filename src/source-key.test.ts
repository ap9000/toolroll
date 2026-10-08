/**
 * Per-source budgets count a native IPv6 caller by its /64 (source-key.ts): however the address is spelled, and
 * whichever address inside the /64 it uses, it is one source. IPv4, IPv4-mapped IPv6, ::1, the trusted proxy's
 * `fwd:` marker and non-address keys stay as they were.
 */
import { expect, test } from "vitest";
import { sourceKey } from "./source-key.js";
import { SourceAdmission } from "./request-budget.js";
import { PasswordGuard, SourceBudget } from "./sign-in-guard.js";

test.each([
  ["2001:db8:1:2::1", "2001:db8:1:2::/64"],
  ["2001:0DB8:0001:0002:0000:0000:0000:0001", "2001:db8:1:2::/64"],
  ["[2001:db8:1:2::abcd]", "2001:db8:1:2::/64"],
  ["fe80::1%en0", "fe80:0:0:0::/64"],
  ["2001:db8:1:2:ffff:ffff:ffff:ffff", "2001:db8:1:2::/64"],
  ["2001:db8:1:3::1", "2001:db8:1:3::/64"],
  ["2001:db8::1.2.3.4", "2001:db8:0:0::/64"],
  ["::ffff:203.0.113.5", "203.0.113.5"],
  ["::ffff:cb00:7105", "203.0.113.5"],
  ["203.0.113.5", "203.0.113.5"],
  ["::1", "::1"],
  ["0:0:0:0:0:0:0:1", "::1"],
  ["fwd:2001:db8:1:2::99", "fwd:2001:db8:1:2::/64"],
  ["fwd:198.51.100.7", "fwd:198.51.100.7"],
  ["unknown", "unknown"],
  ["", ""],
  ["not:an:address", "not:an:address"],
  ["1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7:8:9"],
  ["2001:db8::1::2", "2001:db8::1::2"],
  ["999.1.1.1", "999.1.1.1"],
])("sourceKey(%j) is %j", (address, key) => {
  expect(sourceKey(address)).toBe(key);
});

test("a source admission counts one /64 once, and the next /64 apart", () => {
  const budget = new SourceAdmission({ perMinute: 2, clock: () => 1_000_000 });
  expect(budget.admit("2001:db8:1:2::1").ok).toBe(true);
  expect(budget.admit("2001:0db8:0001:0002:ffff::9").ok).toBe(true);
  expect(budget.admit("[2001:db8:1:2::abcd]")).toMatchObject({ ok: false, status: 429 });
  expect(budget.admit("2001:db8:1:3::1").ok).toBe(true);
  expect(budget.size).toBe(2);
  // IPv4 stays exact, and its mapped spelling is the same caller.
  expect(budget.admit("198.51.100.7").ok).toBe(true);
  expect(budget.admit("::ffff:198.51.100.7").ok).toBe(true);
  expect(budget.admit("198.51.100.7").ok).toBe(false);
  expect(budget.admit("198.51.100.8").ok).toBe(true);
});

test("sign-in tries from one /64 share their budget, whichever address they use", () => {
  const budget = new SourceBudget(3, 60_000);
  for (const address of ["fwd:2001:db8:5:6::1", "fwd:2001:db8:5:6::2", "fwd:2001:db8:5:6:a:b:c:d"]) budget.failed(address, 0);
  expect(budget.waitFor("fwd:2001:db8:5:6::ffff", 1)).toBeGreaterThan(0);
  expect(budget.waitFor("fwd:2001:db8:5:7::1", 1)).toBe(0);
});

test("a password lock holds for the whole /64 that earned it", () => {
  const guard = new PasswordGuard();
  for (let i = 0; i < 5; i++) guard.failed("alex", 0, `fwd:2001:db8:9:9::${i + 1}`, true);
  expect(guard.lockedFor("alex", 1, "fwd:2001:db8:9:9::77")).toBeGreaterThan(0);
  expect(guard.lockedFor("alex", 1, "fwd:2001:db8:9:a::1")).toBe(0);
});
