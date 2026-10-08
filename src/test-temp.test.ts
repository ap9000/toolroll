/**
 * Tests leave no temp folders: each test run's workers write into one temp root the global teardown removes, and
 * `toolroll storage clean` removes test folders nothing touched for a day.
 */
import { afterEach, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import tempRoot from "../test/temp-root.js";
import { fakePid } from "../test/fake-pid.js";
import { isTestTemp, OWNER_FILE, removeStaleTestTemp, tempOwner, testTempFolders } from "./test-temp.js";
import { execFileSync } from "node:child_process";

const DAY = 86_400_000;
const made: string[] = [];
afterEach(() => { for (const one of made.splice(0)) rmSync(one, { recursive: true, force: true }); });

test("this run's workers write into the run's own temp root", () => {
  expect(basename(tmpdir())).toMatch(/^so-t/);
  expect(process.env.TMPDIR).toBe(tmpdir());
});

test("the global teardown removes the run's temp root and everything a test left in it, and puts TMPDIR back", () => {
  const before = process.env.TMPDIR;
  const teardown = tempRoot();
  try {
    const root = tmpdir();
    expect(dirname(root)).toBe(before);
    const left = mkdtempSync(join(tmpdir(), "so-route-cli-"));
    writeFileSync(join(left, "db.sqlite"), "x");
    teardown();
    expect(existsSync(left)).toBe(false);
    expect(existsSync(root)).toBe(false);
  } finally {
    expect(process.env.TMPDIR).toBe(before);
  }
});

test("leftovers: test folders nothing touched for a day, judged by the folder and what is directly in it", () => {
  const root = mkdtempSync(join(tmpdir(), "so-temp-scan-"));
  made.push(root);
  const now = new Date();
  const old = new Date(now.getTime() - 2 * DAY);
  const folder = (name: string, touched: Date, child: Date = touched) => {
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, "file"), "x");
    utimesSync(join(root, name, "file"), child, child);
    utimesSync(join(root, name), touched, touched);
    return join(root, name);
  };
  const stale = folder("standing-orders-stub-abc", old);
  const busy = folder("toolroll-agent-db-abc", old, now); // a live run's database written just now
  const fresh = folder("epoch-123", now);
  const other = folder("not-a-test-folder", old);
  symlinkSync(stale, join(root, "so-link-to-it"));
  const found = testTempFolders([root], now);
  expect(found.all.map(one => one.path).sort()).toEqual([busy, fresh, stale].sort());
  expect(found.stale.map(one => one.path)).toEqual([stale]);
  expect(removeStaleTestTemp([root], now)).toEqual({ removed: [stale], failed: [], more: false });
  expect([stale, busy, fresh, other].map(existsSync)).toEqual([false, true, true, true]);
  expect(isTestTemp("playwright_chromiumdev_profile-AbC123")).toBe(true);
  expect(isTestTemp("com.apple.launchd.x")).toBe(false);
});

test("a stale-looking root whose owner still runs stays; a pass removes at most its share and says more are left", () => {
  const root = mkdtempSync(join(tmpdir(), "so-temp-owner-"));
  made.push(root);
  const now = new Date();
  const old = new Date(now.getTime() - 2 * DAY);
  const folder = (name: string, owner?: number) => {
    mkdirSync(join(root, name));
    if (owner !== undefined) writeFileSync(join(root, name, OWNER_FILE), JSON.stringify({ pid: owner, startedAt: old.toISOString() }));
    for (const one of readdirSync(join(root, name))) utimesSync(join(root, name, one), old, old);
    utimesSync(join(root, name), old, old);
    return join(root, name);
  };
  const runningOwner = fakePid(1), goneOwner = fakePid(2);
  const running = folder("so-e2e-tmp-running", runningOwner);
  const gone = folder("so-e2e-tmp-gone", goneOwner);
  const plain = [folder("so-a"), folder("so-b"), folder("so-c")];
  expect(tempOwner(running)).toEqual({ pid: runningOwner, startedAt: old.getTime() });
  expect(tempOwner(plain[0]!)).toBeNull();
  const ownerAlive = (owner: { pid: number }) => owner.pid === runningOwner;
  const first = removeStaleTestTemp([root], now, { ownerAlive, max: 2 });
  expect(first.more).toBe(true);
  expect(first.removed).toHaveLength(2);
  const rest = removeStaleTestTemp([root], now, { ownerAlive });
  expect(rest.more).toBe(false);
  expect([...first.removed, ...rest.removed].sort()).toEqual([gone, ...plain].sort());
  expect(existsSync(running)).toBe(true);
});

test("a stale root a test made read-only is still removed", () => {
  const root = mkdtempSync(join(tmpdir(), "so-temp-readonly-"));
  made.push(root);
  const now = new Date();
  const old = new Date(now.getTime() - 2 * DAY);
  const locked = join(root, "so-locked");
  mkdirSync(join(locked, "inner"), { recursive: true });
  writeFileSync(join(locked, "inner", "file"), "x");
  execFileSync("chmod", ["-R", "a-w", join(locked, "inner")]);
  utimesSync(join(locked, "inner"), old, old);
  utimesSync(locked, old, old);
  expect(removeStaleTestTemp([root], now)).toEqual({ removed: [locked], failed: [], more: false });
  expect(existsSync(locked)).toBe(false);
});
