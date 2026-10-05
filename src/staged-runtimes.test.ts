/**
 * Staged runtimes: the current one, the one before it, the newest, one still under way and one holding a kept-aside
 * database stay; the rest of `browser-*` and `release-*` go. With no runtime in use, nothing goes. Rollback records,
 * links and anything else in the folder are never touched.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneStagedRuntimes, runtimesInUse, stagePlan } from "./staged-runtimes.js";

const DAY = 86_400_000;
let state: string, root: string;
beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "so-staged-"));
  root = join(state, "staged-upgrades");
  mkdirSync(root);
});
afterEach(() => rmSync(state, { recursive: true, force: true }));

const now = new Date();
/** A deploy's stage: its journal says when, how far it got and what ran before it. */
function deploy(name: string, ageDays: number, phase = "deployed", prior: string | null = null): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "runtime", "dist"), { recursive: true });
  const at = new Date(now.getTime() - ageDays * DAY).toISOString();
  writeFileSync(join(dir, "deployment.json"), JSON.stringify({ phase, createdAt: at, ...(phase === "deployed" ? { deployedAt: at } : {}), ...(prior === null ? {} : { priorRuntime: join(prior, "runtime", "dist") }) }));
  return dir;
}

test("keeps the current runtime, the one before it and the newest; removes the rest", () => {
  const oldest = deploy("browser-a", 9);
  const before = deploy("browser-b", 8);
  const previous = deploy("browser-c", 6, "deployed", before);
  const current = deploy("browser-d", 5, "deployed", previous);
  const newest = deploy("browser-e", 1, "rehearse");
  const failed = deploy("browser-f", 3, "rehearse");
  const abandoned = deploy("browser-g", 10, "swap");
  const update = join(root, "release-0.9.30-abcd1234");
  mkdirSync(update);
  writeFileSync(join(update, "update.json"), JSON.stringify({ startedAt: new Date(now.getTime() - 4 * DAY).toISOString(), finishedAt: new Date(now.getTime() - 4 * DAY).toISOString(), from: { dist: "/elsewhere" } }));
  const keptAside = join(root, "release-0.9.29-ffff0000");
  mkdirSync(keptAside);
  writeFileSync(join(keptAside, "update.json"), JSON.stringify({ startedAt: new Date(now.getTime() - 20 * DAY).toISOString(), finishedAt: "x" }));
  writeFileSync(join(keptAside, "orders.kept.db"), "the only copy");
  const rollback = join(root, "rollback-0.9.28-00000000");
  mkdirSync(rollback);
  const elsewhere = mkdtempSync(join(state, "browser-outside-"));
  symlinkSync(elsewhere, join(root, "browser-link"));

  const inUse = [join(current, "runtime", "dist", "cli.js")];
  const plan = stagePlan(state, inUse, now);
  expect(plan.refused).toBeNull();
  expect(Object.fromEntries(plan.keep.map(one => [one.path.split("/").at(-1), one.why]))).toEqual({
    "browser-d": "current", "browser-c": "previous", "browser-e": "newest", "browser-f": "under way", "release-0.9.29-ffff0000": "kept-aside database",
  });
  expect(plan.go.map(one => one.name).sort()).toEqual(["browser-a", "browser-b", "browser-g", "release-0.9.30-abcd1234"]);

  const done = pruneStagedRuntimes(state, now, { inUse: () => inUse });
  expect(done.refused).toBeNull();
  expect(done.removed.map(path => path.split("/").at(-1)).sort()).toEqual(["browser-a", "browser-b", "browser-g", "release-0.9.30-abcd1234"]);
  for (const kept of [previous, current, newest, failed, keptAside, rollback, elsewhere, join(root, "browser-link")]) expect(existsSync(kept), kept).toBe(true);
  for (const gone of [oldest, before, abandoned, update]) expect(existsSync(gone)).toBe(false);
});

test("with no staged runtime in use, which one runs is unknown: nothing goes", () => {
  deploy("browser-a", 9);
  deploy("browser-b", 8);
  const done = pruneStagedRuntimes(state, now, { inUse: () => ["/usr/local/lib/node_modules/toolroll/dist/cli.js"] });
  expect(done).toEqual({ removed: [], failed: [], refused: "no staged runtime is in use, so which one runs now is unknown" });
  expect(readdirSync(root).sort()).toEqual(["browser-a", "browser-b"]);
});

test("a stage that comes into use between the plan and its removal stays", () => {
  const current = deploy("browser-c", 2);
  const old = deploy("browser-a", 9);
  deploy("browser-b", 8);
  let looks = 0;
  const inUse = () => { looks++; return looks === 1 ? [join(current, "runtime")] : [join(current, "runtime"), join(old, "runtime", "dist", "cli.js")]; };
  const done = pruneStagedRuntimes(state, now, { inUse });
  expect(existsSync(old)).toBe(true);
  expect(done.removed).toEqual([]);
});

test("what runs a runtime: launchd services, toolroll commands on PATH and under nvm, and this process", () => {
  const home = mkdtempSync(join(state, "home-"));
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(join(home, "Library", "LaunchAgents", "com.toolroll.browser.plist"), `<plist><string>${root}/browser-x/runtime/dist/cli.js</string><string>--port</string></plist>`);
  writeFileSync(join(home, "Library", "LaunchAgents", "com.other.plist"), `<string>${root}/browser-y/cli.js</string>`);
  const bin = join(home, "bin");
  mkdirSync(bin);
  symlinkSync(`${root}/browser-z/runtime/bin.js`, join(bin, "toolroll"));
  const found = runtimesInUse(["/extra"], home, bin);
  expect(found).toContain(`${root}/browser-x/runtime/dist/cli.js`);
  expect(found).not.toContain(`${root}/browser-y/cli.js`);
  expect(found).toContain(join(bin, "toolroll"));
  expect(found).toContain("/extra");
  utimesSync(home, now, now);
});
