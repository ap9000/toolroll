// The Settings journey's own rules (Settings revamp S1): its fixture never reaches the person's real setup, step files
// are console paths only, and the allowlist splits known from new findings. The journey itself runs as
// `node scripts/settings-journey.mjs`; it isn't part of the unit suite.
import { expect, test } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertFixtureSafe, LIVE_PORT, ROOT } from "../scripts/settings-journey/fixture.mjs";
import { classify, findingKey, loadStep, readAllowlist, sidebarDrift, stepNames, stepProblems } from "../scripts/settings-journey.mjs";
import { PROBE_NAMES } from "../scripts/settings-journey/probes.mjs";

const temp = () => realpathSync(mkdtempSync(join(tmpdir(), "journey-guard-")));

test("the fixture guard refuses every path that leaves its temp root or reaches the real setup", () => {
  const root = temp();
  const home = temp();
  mkdirSync(join(root, "db"));
  expect(() => assertFixtureSafe({ root, home, paths: { db: join(root, "db", "orders.db") }, port: 50123 })).not.toThrow();
  const refused: Array<[string, Parameters<typeof assertFixtureSafe>[0]]> = [
    ["outside the root", { root, home, paths: { db: join(home, "orders.db") } }],
    ["the live port", { root, home, paths: {}, port: LIVE_PORT }],
    ["no port at all", { root, home, paths: {}, port: 0 }],
    ["a root that isn't temporary", { root: ROOT, home, paths: {} }],
    ["a root holding the home", { root: tmpdir(), home: join(tmpdir(), "someone"), paths: {} }],
    ["the live database by name", { root, home, liveDb: [join(root, "plane.db")], paths: { db: join(root, "plane.db") } }],
    ["the real config folder", { root: join(home, ".config", "standing-orders"), home, paths: { db: join(home, ".config", "standing-orders", "orders.db") } }],
  ];
  mkdirSync(join(home, ".config", "standing-orders"), { recursive: true });
  for (const [why, input] of refused) expect(() => assertFixtureSafe(input), why).toThrow();
  // A symlink inside the root that points out of it is judged by where it lands.
  symlinkSync(home, join(root, "escape"));
  expect(() => assertFixtureSafe({ root, home, paths: { config: join(root, "escape") } })).toThrow(/outside the fixture root/);
});

test("step files name console paths, unique slugs and known probes; the shipped ones load", async () => {
  const good = { about: "x", pages: [{ name: "hub", path: "/settings" }] };
  expect(stepProblems(good, "ok")).toEqual([]);
  const bad: Array<[string, object]> = [
    ["a host", { about: "x", pages: [{ name: "a", path: "https://example.com/" }] }],
    ["a protocol-relative host", { about: "x", pages: [{ name: "a", path: "//example.com/settings" }] }],
    ["a duplicate name", { about: "x", pages: [{ name: "a", path: "/a" }, { name: "a", path: "/b" }] }],
    ["an unknown probe", { about: "x", pages: [{ name: "a", path: "/a", skip: ["vibes"] }] }],
    ["an unknown account", { about: "x", pages: [{ name: "a", path: "/a", as: "root" }] }],
    ["an unknown fixture", { about: "x", fixture: "prod", pages: [{ name: "a", path: "/a" }] }],
    ["an action without run", { about: "x", actions: [{ name: "a" }] }],
    ["nothing to do", { about: "x" }],
  ];
  for (const [why, step] of bad) expect(stepProblems(step, "s"), why).not.toEqual([]);
  expect(stepProblems(good, "../escape")).not.toEqual([]);
  for (const name of stepNames()) await expect(loadStep(name)).resolves.toBeDefined();
});

test("the allowlist keeps known findings from failing, fails new ones, and names lines that now pass", () => {
  const one = { step: "baseline", page: "hub", width: "390", probe: "targets", detail: "3 short" };
  const two = { ...one, probe: "secrets", detail: "missing opt-outs" };
  const allow = { [findingKey(one)]: "S2", [findingKey({ ...one, probe: "one-h1" })]: "S2", "other/page@390:targets": "not run here" };
  const ran = new Set([findingKey(one), findingKey(two), findingKey({ ...one, probe: "one-h1" })]);
  expect(classify([one, two], allow, ran)).toEqual({ fresh: [two], known: [one], burned: ["baseline/hub@390:one-h1"] });
  // Every shipped allowlist line names a step file and a probe the runner knows.
  const steps = stepNames();
  for (const key of Object.keys(readAllowlist())) {
    const match = /^([a-z0-9-]+)\/([a-z0-9-]+)@(1440|390):([a-z0-9-]+)$/.exec(key);
    expect(match, key).not.toBeNull();
    expect(steps, key).toContain(match![1]);
    expect([...PROBE_NAMES, "load"], key).toContain(match![4]);
  }
});

test("sidebar drift is measured against the rows most pages show", () => {
  expect(sidebarDrift({ a: ["x", "y"], b: ["x", "y"], c: ["x"] })).toEqual([{ page: "c", detail: "sidebar differs from the other pages; missing: y" }]);
  expect(sidebarDrift({ a: ["x"], b: null })).toEqual([]);
});
