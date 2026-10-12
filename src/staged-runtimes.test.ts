/**
 * Staged runtimes: the current one, the one before it, the newest, one still under way and one holding a kept-aside
 * database stay; the rest of `browser-*` and `release-*` go. With no runtime in use, nothing goes. Rollback records,
 * links and anything else in the folder are never touched.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pruneStagedRuntimes, runtimesInUse, runtimeScriptPaths, stagePlan } from "./staged-runtimes.js";

const DAY = 86_400_000;
let state: string, root: string;
beforeEach(() => {
  state = realpathSync(mkdtempSync(join(tmpdir(), "so-staged-")));
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

test("a CLI link switched at quarantine restores its runtime before any deletion", () => {
  const current = deploy("browser-c", 2), old = deploy("browser-a", 9);
  deploy("browser-b", 8);
  const home = join(state, "home"), bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const inUse = () => runtimesInUse([join(current, "runtime")], home, "/usr/bin:/bin");
  const done = pruneStagedRuntimes(state, now, { inUse, quarantined: (original, trash) => {
    expect(original).toBe(old);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(trash)).toBe(true);
    symlinkSync(join(old, "runtime", "dist", "cli.js"), join(bin, "toolroll"));
  } });
  expect(done).toEqual({ removed: [], failed: [], refused: null });
  expect(existsSync(join(old, "deployment.json"))).toBe(true);
  expect(readdirSync(root).filter(name => name.startsWith(".toolroll-trash-"))).toEqual([]);
});

test("a partially deleted runtime remains hidden and the next sweep finishes its trash", () => {
  const current = deploy("browser-c", 2), old = deploy("browser-a", 9);
  deploy("browser-b", 8);
  const inUse = () => [join(current, "runtime")];
  const failed = pruneStagedRuntimes(state, now, { inUse, remove: path => {
    rmSync(path, { recursive: true, force: true });
    throw Error("disk refused after partial removal");
  } });
  expect(failed.failed).toEqual([old]);
  expect(existsSync(old)).toBe(false);
  expect(readdirSync(root).filter(name => name.startsWith(".toolroll-trash-"))).toHaveLength(1);
  expect(pruneStagedRuntimes(state, now, { inUse })).toEqual({ removed: [old], failed: [], refused: null });
  expect(readdirSync(root).sort()).toEqual(["browser-b", "browser-c"]);
});

test("quarantine rechecks a newly kept-aside database and preserves the age of unfinished stages", () => {
  const current = deploy("browser-c", 2), old = deploy("browser-a", 9);
  deploy("browser-b", 8);
  const unfinished = join(root, "browser-abandoned with spaces");
  mkdirSync(unfinished);
  const before = new Date(now.getTime() - 10 * DAY);
  utimesSync(unfinished, before, before);
  const result = pruneStagedRuntimes(state, now, { inUse: () => [join(current, "runtime")], quarantined: (original, trash) => {
    if (original === old) writeFileSync(join(trash, "orders.kept.db"), "keep this database");
  } });
  expect(result).toEqual({ removed: [unfinished], failed: [], refused: null });
  expect(existsSync(join(old, "orders.kept.db"))).toBe(true);
});

test("what runs a runtime: launchd services, toolroll commands on PATH and under nvm, and this process", () => {
  const home = mkdtempSync(join(state, "home-"));
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(join(home, "Library", "LaunchAgents", "com.toolroll.browser.plist"), `<plist><string>${root}/browser-x/runtime/dist/cli.js</string><string>--port</string></plist>`);
  writeFileSync(join(home, "Library", "LaunchAgents", "com.other.plist"), `<string>${root}/browser-y/cli.js</string>`);
  const bin = join(home, "bin");
  mkdirSync(bin);
  symlinkSync(`${root}/browser-z/runtime/bin.js`, join(bin, "toolroll"));
  // A launchd worker's PATH is short: the usual link folder counts whether or not it is on it.
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  symlinkSync(`${root}/browser-w/runtime/dist/cli.js`, join(home, ".local", "bin", "standing-orders"));
  expect(runtimesInUse([], home, "")).toContain(join(home, ".local", "bin", "standing-orders"));
  const found = runtimesInUse(["/extra"], home, bin);
  expect(found).toContain(`${root}/browser-x/runtime/dist/cli.js`);
  expect(found).not.toContain(`${root}/browser-y/cli.js`);
  expect(found).toContain(join(bin, "toolroll"));
  expect(found).toContain("/extra");
  utimesSync(home, now, now);
});

test("a long-lived Toolroll mcp script keeps its older stage when cwd and Node are elsewhere", async () => {
  const mcp = deploy("browser-mcp", 20), unused = deploy("browser-unused", 12);
  deploy("browser-previous", 8);
  const current = deploy("browser-current", 2);
  const script = join(mcp, "runtime", "dist", "cli.js");
  writeFileSync(script, "process.send(process.argv); process.on('message', () => process.exit(0));\n");
  const child = spawn(process.execPath, [script, "mcp", "--label", "synthetic argument"], { cwd: state, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const closed = once(child, "exit");
  try {
    const [args] = await once(child, "message");
    // The sandbox denies ps. The real child supplies its argv; only the OS observation is injected.
    const observations = {
      census: () => child.exitCode === null ? [{ pid: child.pid!, ppid: process.pid, pgid: child.pid!, bornAt: Date.now(), name: "node", terminal: false }] : [],
      argv: (pids: readonly number[]) => pids.includes(child.pid!) ? [(args as string[]).join(" ")] : [],
    };
    const scripts = runtimeScriptPaths(state, undefined, observations);
    expect(scripts).toContain(script);
    expect(scripts.some(one => one.includes("synthetic argument"))).toBe(false);
    const inUse = () => runtimesInUse([join(current, "runtime", "dist", "cli.js"), ...runtimeScriptPaths(state, undefined, observations)], state, "/usr/bin:/bin");
    expect(pruneStagedRuntimes(state, now, { inUse }).removed).toEqual([unused]);
    expect(existsSync(script)).toBe(true);
    process.kill(child.pid!, 0);
    child.send("finish");
    await closed;
    expect(pruneStagedRuntimes(state, now, { inUse }).removed).toEqual([mcp]);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await closed;
  }
});
