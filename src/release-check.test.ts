import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { partTempRoot, planFor, versionOnly } from "../scripts/release-check.mjs";
import { atLeast, completionProblems, FIRST_RELEASE, installPublished, lastPublished, LONG_TEXT, missingTables, ROLLBACK_FROM, upgradeVersions } from "../scripts/upgrade-path.mjs";
import { gateWords, openGate, providerCap } from "../scripts/provider-gate.mjs";
import { fakePid } from "../test/fake-pid.js";

const pkg = (version: string, dependencies: Record<string, string> = { zod: "^3.23.0" }) => JSON.stringify({ name: "toolroll", version, type: "module", dependencies }, null, 2) + "\n";
const lock = (version: string, zod = "3.23.8") => JSON.stringify({
  name: "toolroll", version, lockfileVersion: 3, requires: true,
  packages: { "": { name: "toolroll", version, dependencies: { zod: "^3.23.0" } }, "node_modules/zod": { version: zod, resolved: `https://registry.npmjs.org/zod/-/zod-${zod}.tgz` } },
}, null, 2) + "\n";
/** A repository in `dir` with `base` committed, then one commit with `change`; the base commit. */
const repoWith = (dir: string, base: Record<string, string>, change: Record<string, string>) => {
  const git = (...argv: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@example.invalid", ...argv], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  const write = (files: Record<string, string>) => { for (const [file, text] of Object.entries(files)) { mkdirSync(join(dir, file, ".."), { recursive: true }); writeFileSync(join(dir, file), text); } };
  write(base);
  git("add", "."); git("commit", "-qm", "base");
  const at = git("rev-parse", "HEAD");
  write(change);
  git("add", "."); git("commit", "-qm", "change");
  return at;
};
const script = resolve(import.meta.dirname, "../scripts/release-check.mjs");

describe("a release's version bump", () => {
  test("only the project's own version changed: not a dependency change", () => {
    expect(versionOnly("package.json", pkg("0.9.5"), pkg("0.9.6"))).toBe(true);
    expect(versionOnly("package-lock.json", lock("0.9.5"), lock("0.9.6"))).toBe(true);
  });

  test("a dependency, its locked version, a missing side or unreadable JSON is a real change", () => {
    expect(versionOnly("package.json", pkg("0.9.5"), pkg("0.9.6", { zod: "^3.24.0" }))).toBe(false);
    expect(versionOnly("package-lock.json", lock("0.9.5"), lock("0.9.6", "3.24.1"))).toBe(false);
    expect(versionOnly("package.json", null, pkg("0.9.6"))).toBe(false);
    expect(versionOnly("package.json", pkg("0.9.5"), "{")).toBe(false);
    expect(versionOnly("src/version.ts", "a", "a")).toBe(false);
  });

  test("the plan: a bump alone or beside docs runs nothing more; beside code, or without the bump, everything", () => {
    const bumps = ["package.json", "package-lock.json"];
    expect(planFor(["package.json", "package-lock.json", "CHANGELOG.md"], { versionBumps: bumps })).toMatchObject({ checks: false, real: false });
    expect(planFor(["package.json", "package-lock.json", "src/store.ts"], { versionBumps: bumps })).toMatchObject({ checks: true, real: false });
    expect(planFor(["package.json", "package-lock.json"])).toMatchObject({ checks: true });
    expect(planFor(["CHANGELOG.md"], { full: true, versionBumps: ["package.json"] })).toMatchObject({ checks: true, real: true });
  });
});

describe("what a change runs", () => {
  test("docs, evidence and design notes run nothing; any other change runs every unit test, every scripted journey and the upgrade path", () => {
    for (const changed of [["docs/x.md", "CHANGELOG.md"], ["evidence/shot.png"], ["design/notes.md", "LICENSE"]])
      expect(planFor(changed), changed.join()).toEqual({ checks: false, real: false, why: "only docs, evidence or design notes changed" });
    for (const changed of [["src/spend.ts"], ["src/browser/app.tsx"], ["src/store.test.ts"], ["scripts/upgrade-path.mjs"], ["vitest.config.ts", "docs/x.md"]])
      expect(planFor(changed), changed.join()).toEqual({ checks: true, real: false, why: "every unit test and every scripted browser journey; no real-model journeys (no model-facing code changed; --real runs them)" });
    // Another project's checkout, with no journey scripts.
    expect(planFor(["src/spend.ts"], { journeys: false }).why).toBe("every unit test");
  });

  test("model-facing code adds the real-model journeys; a test of it doesn't; --real and a full check do", () => {
    for (const file of ["src/mate.ts", "src/mate-tools.ts", "src/subscription-chat.ts", "src/planner.ts", "src/builder.ts", "src/provider.ts", "src/invoke.ts", "src/teammates.ts", "src/flow-sort.ts", "src/task-sizing.ts"])
      expect(planFor([file]), file).toEqual({ checks: true, real: true, why: `every unit test and every scripted browser journey; the real-model journeys and what they need (${file} changed: model-facing)` });
    expect(planFor(["src/mate.test.ts"]).real).toBe(false);
    expect(planFor(["src/browser/app.tsx"], { real: true }).why).toBe("every unit test and every scripted browser journey; the real-model journeys and what they need (--real)");
    expect(planFor(["docs/guide/flows.md"], { real: true })).toEqual({ checks: false, real: true, why: "no unit tests or scripted journeys (nothing a test reads changed); the real-model journeys and what they need (--real)" });
    expect(planFor([], { full: true })).toEqual({ checks: true, real: true, why: "a full check: every unit test, every scripted and real-model browser journey" });
  });

  test("browser lanes and units own their roots without an extra release-check socket-path level", () => {
    expect(["unit", "app", "flows", "app-real", "flows-real"].map(partTempRoot)).toEqual([false, false, false, false, false]);
    expect(["typecheck", "build", "upgrade"].map(partTempRoot)).toEqual([true, true, true]);
  });
});

describe("node scripts/release-check.mjs", () => {
  let dir: string | null = null;
  afterEach(() => { if (dir !== null) rmSync(dir, { recursive: true, force: true }); dir = null; });
  const fresh = () => (dir = mkdtempSync(join(tmpdir(), "so-release-check-")));

  test("--plan: a version-only package.json and lockfile change plans nothing more; a real dependency change, everything", () => {
    const planOf = (change: Record<string, string>) => {
      const at = fresh();
      const base = repoWith(at, { "package.json": pkg("0.9.5"), "package-lock.json": lock("0.9.5"), "store.ts": "export const a = 1;\n" }, change);
      return execFileSync(process.execPath, [script, "--plan", "--base", base], { cwd: at, encoding: "utf8" }).trim();
    };
    expect(planOf({ "package.json": pkg("0.9.6"), "package-lock.json": lock("0.9.6") }))
      .toMatch(/\(2 changed files\): nothing a test reads changed; only the version changed in package-lock\.json and package\.json\.$/);
    rmSync(dir!, { recursive: true, force: true });
    expect(planOf({ "package.json": pkg("0.9.6", { zod: "^3.24.0" }), "package-lock.json": lock("0.9.6", "3.24.1") }))
      .toMatch(/\(2 changed files\): every unit test\.$/);
  });

  test("a run: the unit tests start beside the build and wait for its outcome; the summary keeps its lines and says how long each part took", () => {
    // The stand-in tests wait for the outcome the release check hands them: seeing "ok" means they waited for the build.
    const scripts = { typecheck: "node -e \"console.log('typed')\"", build: "node -e \"console.log('built')\"", test: "node units.cjs" };
    const units = "const fs = require('fs'), m = process.env.TOOLROLL_RELEASE_BUILD;\n" +
      "const wait = () => fs.existsSync(m) ? console.log(' Test Files  1 passed (1) after ' + fs.readFileSync(m, 'utf8')) : setTimeout(wait, 20);\nwait();\n";
    const manifest = (version: string) => JSON.stringify({ name: "toolroll", version, scripts }, null, 2) + "\n";
    const at = fresh();
    const base = repoWith(at, { "package.json": manifest("0.9.5"), "units.cjs": units }, { "package.json": manifest("0.9.6"), "test/setup.ts": "export {};\n" });
    const out = execFileSync(process.execPath, [script, "--base", base], { cwd: at, encoding: "utf8", env: { ...process.env, TOOLROLL_CHECK_GATE: "", TOOLROLL_CHECK_PROVIDERS: "" } });
    expect(out).toContain("(2 changed files): every unit test; only the version changed in package.json.");
    const summary = out.slice(out.indexOf("== summary"));
    expect(summary.split("\n").slice(0, 4)).toEqual(["== summary", "plan: every unit test; only the version changed in package.json", "unit: exit 0", " Test Files  1 passed (1) after ok"]);
    expect(summary).toMatch(/\ntook: typecheck \d+ s, build \d+ s, unit \d+ s; whole check \d+ s\n$/);
  });

  /** A checkout with journey scripts and a stand-in runner that logs how it is asked to run (and whether it was handed
   * a provider gate), then one commit changing `files`; the release check's output, and each journey run it started. */
  const checkOf = (files: Record<string, string>, extra: string[] = [], build = "node -e 0") => {
    const at = fresh();
    const runner = "import { appendFileSync } from 'node:fs';\nappendFileSync('journey-runs.jsonl', JSON.stringify({ argv: process.argv.slice(2), gate: process.env.TOOLROLL_CHECK_GATE ?? null }) + '\\n');\nconsole.log('Model calls: 4 scripted, 0 real turns');\n";
    const base = repoWith(at, {
      "scripts/e2e-parallel.mjs": runner, "scripts/flows-e2e.mjs": "", "scripts/app-e2e.mjs": "",
      "package.json": JSON.stringify({ name: "toolroll", version: "0.9.5", scripts: { typecheck: "node -e 0", build, test: "node -e 0" } }, null, 2) + "\n",
      "src/browser/app.tsx": "export {};\n", "src/mate.ts": "export {};\n",
    }, files);
    let out: string;
    try { out = execFileSync(process.execPath, [script, "--base", base, ...extra], { cwd: at, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "", TOOLROLL_CHECK_GATE: "", TOOLROLL_CHECK_PROVIDERS: "" } }); } catch (error) { out = (error as { stdout: string }).stdout; }
    const runs = existsSync(join(at, "journey-runs.jsonl")) ? readFileSync(join(at, "journey-runs.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { argv: string[]; gate: string | null }) : [];
    const outputs = runs.map(one => one.argv[one.argv.indexOf("--output") + 1]);
    expect(new Set(outputs).size).toBe(runs.length);
    for (const output of outputs) expect(output).toMatch(/^evidence\/release-\d+\/(app|flows)(-real)?$/);
    // Every real-model run shares one gate; a scripted run gets none.
    const gates = new Set(runs.filter(one => one.argv.includes("real")).map(one => one.gate));
    expect([...gates].every(one => one !== null && one !== "")).toBe(true);
    expect(gates.size).toBeLessThanOrEqual(1);
    for (const one of runs.filter(each => each.argv.includes("scripted"))) expect(one.gate).toBeNull();
    return { out, runs: runs.map(one => one.argv.filter((arg, index) => arg !== "--output" && one.argv[index - 1] !== "--output").join(" ")).sort() };
  };
  const SCRIPTED = ["scripts/app-e2e.mjs --skip-build --journeys scripted --at-once 4", "scripts/flows-e2e.mjs --journeys scripted --at-once 2"];
  const REAL = ["scripts/app-e2e.mjs --skip-build --journeys real --at-once 4", "scripts/flows-e2e.mjs --journeys real --at-once 2"];

  test("any change beyond docs runs every scripted journey group, flows 2 and app 4 at once, and no real-model journey", () => {
    const { out, runs } = checkOf({ "src/browser/app.tsx": "export const changed = 1;\n" });
    expect(out).toContain("every unit test and every scripted browser journey; no real-model journeys");
    expect(runs).toEqual(SCRIPTED);
    expect(out).toContain("\nModel calls: 4 scripted, 0 real turns\n");
    expect(out).not.toContain("provider gate:");
  });

  test("a model-facing change and --real add the real-model groups under one provider gate; docs alone run no journey", () => {
    const model = checkOf({ "src/mate.ts": "export const changed = 1;\n" });
    expect(model.runs).toEqual([REAL[0], SCRIPTED[0], REAL[1], SCRIPTED[1]]);
    expect(model.out).toMatch(/\nprovider gate: nothing started\n$/);
    expect(checkOf({ "docs/x.md": "# x\n" }, ["--real"]).runs).toEqual(REAL);
    expect(checkOf({ "docs/x.md": "# x\n" }).runs).toEqual([]);
  });

  test("a failed build holds the journeys", () => {
    const { out, runs } = checkOf({ "src/browser/app.tsx": "export const changed = 1;\n" }, [], "node -e \"process.exit(1)\"");
    expect(runs).toEqual([]);
    expect(out).toContain("\nbuild: exit 1\n");
    expect(out).toContain("\nbrowser journeys not run: the typecheck or build failed\n");
  });
});

describe("the upgrade path step", () => {
  test("a published release is installed once, then copied from the cache; an interrupted install is not used", () => {
    const root = mkdtempSync(join(tmpdir(), "so-upgrade-cache-"));
    try {
      const cache = join(root, "cache");
      let installs = 0;
      // npm's global layout: the command a relative link into lib/node_modules.
      const install = (into: string) => {
        installs++;
        mkdirSync(join(into, "lib", "node_modules", "toolroll", "dist"), { recursive: true }); mkdirSync(join(into, "bin"));
        writeFileSync(join(into, "lib", "node_modules", "toolroll", "dist", "bin.js"), "// 0.9.7\n");
        symlinkSync("../lib/node_modules/toolroll/dist/bin.js", join(into, "bin", "toolroll"));
      };
      // A run killed mid-install left a partial copy behind.
      mkdirSync(join(cache, "0.9.7", "lib"), { recursive: true });
      expect(installPublished("0.9.7", join(root, "a"), {}, { cache, install })).toBe("installed");
      expect(installPublished("0.9.7", join(root, "b"), {}, { cache, install })).toBe("cached");
      expect(installs).toBe(1);
      for (const home of ["a", "b"]) {
        expect(readlinkSync(join(root, home, "bin", "toolroll"))).toBe("../lib/node_modules/toolroll/dist/bin.js");
        expect(realpathSync(join(root, home, "bin", "toolroll"))).toBe(realpathSync(join(root, home, "lib", "node_modules", "toolroll", "dist", "bin.js")));
        expect(existsSync(join(root, home, ".complete"))).toBe(false);
      }
      // Each home is its own copy: what one release's run writes never reaches the cache.
      writeFileSync(join(root, "a", "lib", "node_modules", "toolroll", "dist", "bin.js"), "changed");
      expect(readFileSync(join(cache, "0.9.7", "lib", "node_modules", "toolroll", "dist", "bin.js"), "utf8")).toBe("// 0.9.7\n");
      expect(() => installPublished("../x", join(root, "c"), {}, { cache, install })).toThrow("not a release version");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("published releases, oldest first; a prerelease is not one", () => {
    expect(lastPublished(["0.9.10", "0.9.4", "0.9.9-beta.1", "0.9.8", "0.10.0", "0.9.9"], 3)).toEqual(["0.9.9", "0.9.10", "0.10.0"]);
    expect(lastPublished(["0.9.10", "0.9.4", "0.9.9-beta.1"])).toEqual(["0.9.4", "0.9.10"]);
  });

  test("every published release from 0.5.0 (the v107 baseline) is on the upgrade path, 0.9.11 among them", () => {
    expect(FIRST_RELEASE).toBe("0.5.0");
    expect(upgradeVersions(["0.4.2", "0.9.11", "0.5.0", "0.6.0-rc.1", "0.6.0", "0.9.10", "0.10.0"])).toEqual(["0.5.0", "0.6.0", "0.9.10", "0.9.11", "0.10.0"]);
    // The step that frees what a killed 0.9.11 left behind runs before `toolroll update`.
    const path = readFileSync("scripts/upgrade-path.mjs", "utf8");
    const onePath = path.slice(path.indexOf("async function onePath("));
    expect(onePath.indexOf("killedCodingOwner(")).toBeGreaterThan(-1);
    expect(onePath.indexOf("killedCodingOwner(")).toBeLessThan(onePath.indexOf('step("toolroll update"'));
    // The baseline release proves the baseline: its new database is the candidate's v107 shape.
    expect(onePath.indexOf('step("baseline shape"')).toBeGreaterThan(-1);
    expect(onePath.indexOf('step("baseline shape"')).toBeLessThan(onePath.indexOf('step("database"'));
  });

  test("the rollback leg: from 0.9.23 on, the release reads back the candidate's long text (same schema), then toolroll update --rollback restores it", () => {
    expect(ROLLBACK_FROM).toBe("0.9.23");
    expect(LONG_TEXT).toEqual({ goal: 8_000, note: 4_000, instructions: 8_000 });
    expect(["0.9.11", "0.9.22", "0.9.23", "0.9.25", "0.9.26", "0.10.0"].filter(one => atLeast(one, ROLLBACK_FROM))).toEqual(["0.9.23", "0.9.25", "0.9.26", "0.10.0"]);
    const onePath = readFileSync("scripts/upgrade-path.mjs", "utf8").slice(readFileSync("scripts/upgrade-path.mjs", "utf8").indexOf("async function onePath("));
    expect(onePath.indexOf('step("rollback read"')).toBeGreaterThan(onePath.indexOf('step("inspect (updated)"'));
    expect(onePath.indexOf('step("toolroll status (rollback read)"')).toBeGreaterThan(onePath.indexOf('step("rollback read"'));
    // The release must load the flow whose zone has the candidate's longest instructions, not only the goal and note.
    expect(onePath).toContain("couldn't load the flow whose zone has");
    // Across a schema change the release refuses the newer database, so it is read only when the schemas match.
    expect(onePath).toContain("if (schemas.release >= schemas.candidate)");
    // Then what a person runs to go back, and the release's own checks over the restored database: nothing skipped.
    const rollback = onePath.indexOf('step("toolroll update --rollback"');
    expect(rollback).toBeGreaterThan(onePath.indexOf('step("toolroll status (rollback read)"'));
    expect(onePath).toContain('["update", "--rollback", "--yes", "--now", "--db", seeded.databaseFile]');
    for (const after of ['step("toolroll status (rolled back)"', 'step("toolroll ledger verify (rolled back)"', 'step("inspect (rolled back)"']) expect(onePath.indexOf(after)).toBeGreaterThan(rollback);
    expect(onePath).toContain("rollback discarded what was written after the update");
  });

  test("a completed task must stay complete under the same digest, and every fresh table must exist", () => {
    const before = [{ task: "a", digest: "d1" }, { task: "b", digest: "d2" }, { task: "c", digest: "d3" }];
    expect(completionProblems(before, { a: { state: "complete", digest: "d1" }, b: { state: "complete", digest: "d2" }, c: { state: "complete", digest: "d3" } })).toEqual([]);
    expect(completionProblems(before, { a: { state: "ready-to-check", digest: null }, b: { state: "complete", digest: "other" } }))
      .toEqual(["a is ready-to-check, not complete", "b's completed result changed digest (d2 → other)", "c is gone"]);
    expect(missingTables(["build_review", "run", "task"], ["run", "task"])).toEqual(["build_review"]);
  });
});

describe("the provider gate", () => {
  const RUNNER_A = fakePid(1), RUNNER_B = fakePid(2), DEAD_RUNNER = fakePid(5);
  let dir: string | null = null;
  afterEach(() => { if (dir !== null) rmSync(dir, { recursive: true, force: true }); dir = null; });
  /** A gate on `at` for the runner `owner`, with `others` claude/codex sessions running besides the check's own. */
  const gateOn = (at: string, owner: number, { env = {}, others = 0, log = () => {} }: { env?: Record<string, string>; others?: number; log?: (line: string) => void } = {}) => {
    let leases = 0;
    const gate = openGate({ dir: at, env, owner, everyMs: 1, sessions: () => others + leases, alive: pid => pid !== DEAD_RUNNER, log });
    // Our running turns are sessions too, as pgrep would count them.
    return { ...gate, hold: <T>(label: string, body: (seen: { waitedMs: number }) => Promise<T>) => gate.hold(label, async seen => { leases++; try { return await body(seen); } finally { leases--; } }) };
  };

  test("the cap: 4 by default, or TOOLROLL_CHECK_PROVIDERS, a whole number 1 or more", () => {
    expect(providerCap({})).toEqual({ cap: 4, from: "default" });
    expect(providerCap({ TOOLROLL_CHECK_PROVIDERS: "" })).toEqual({ cap: 4, from: "default" });
    expect(providerCap({ TOOLROLL_CHECK_PROVIDERS: "6" })).toEqual({ cap: 6, from: "TOOLROLL_CHECK_PROVIDERS" });
    for (const bad of ["0", "many", "1.5", "-2"]) expect(() => providerCap({ TOOLROLL_CHECK_PROVIDERS: bad })).toThrow(`TOOLROLL_CHECK_PROVIDERS takes a whole number, 1 or more (not "${bad}").`);
  });

  test("two runners share one cap, the first opener's; the rest start as slots open and the waits are said and recorded", async () => {
    const at = (dir = mkdtempSync(join(tmpdir(), "so-gate-")));
    const lines: string[] = [];
    const waiting = Promise.withResolvers<void>();
    const log = (line: string) => { lines.push(line); if (lines.length === 3) waiting.resolve(); };
    const flows = gateOn(at, RUNNER_A, { env: { TOOLROLL_CHECK_PROVIDERS: "2" }, log });
    const app = gateOn(at, RUNNER_B, { env: { TOOLROLL_CHECK_PROVIDERS: "9" }, log });
    expect([flows.cap, app.cap]).toEqual([2, 2]);
    let running = 0, most = 0;
    const ends = Array.from({ length: 5 }, () => Promise.withResolvers<void>());
    const runs = ends.map((end, n) => (n % 2 === 0 ? flows : app).hold(`group ${n}`, async () => { running++; most = Math.max(most, running); await end.promise; running--; }));
    await waiting.promise;
    expect(running).toBe(2);
    expect(lines.every(line => /^waiting for room to start group [1-4]: 2 provider turns of ours and 0 other sessions running, at the cap of 2$/.test(line))).toBe(true);
    for (const end of ends) end.resolve();
    await Promise.all(runs);
    expect(most).toBe(2);
    const facts = flows.facts();
    expect(facts).toMatchObject({ starts: 5, most: 2, cap: 2, from: "TOOLROLL_CHECK_PROVIDERS", others: 0, waits: 3 });
    expect(gateWords(facts)).toMatch(/^provider gate: up to 2 real turns at once, 0 other sessions \(cap 2, TOOLROLL_CHECK_PROVIDERS\); 3 starts waited \d+ s in all for a slot \(longest: group [1-4]\)$/);
    expect(flows.facts(RUNNER_A)).toMatchObject({ starts: 3 });
    expect(readdirSync(join(at, "leases"))).toEqual([]);
    flows.close(); app.close();
  });

  test("other sessions take room from the cap, but the check always gets one turn", async () => {
    const at = (dir = mkdtempSync(join(tmpdir(), "so-gate-")));
    const waiting = Promise.withResolvers<string>();
    const gate = gateOn(at, RUNNER_A, { others: 9, log: line => waiting.resolve(line) });
    const end = Promise.withResolvers<void>();
    const first = gate.hold("app lead", () => end.promise);
    let second = false;
    const next = gate.hold("app maya", async () => { second = true; });
    expect(await waiting.promise).toBe("waiting for room to start app maya: 1 provider turn of ours and 9 other sessions running, at the cap of 4");
    expect(second).toBe(false);
    end.resolve();
    await Promise.all([first, next]);
    expect(second).toBe(true);
    expect(gate.facts()).toMatchObject({ starts: 2, most: 1, others: 9, waits: 1 });
    gate.close();
  });

  test("a dead runner's lease is dropped, and a body that throws lets go of its own", async () => {
    const at = (dir = mkdtempSync(join(tmpdir(), "so-gate-")));
    const gate = gateOn(at, RUNNER_A, { env: { TOOLROLL_CHECK_PROVIDERS: "1" } });
    // A runner killed outright left its lease behind: it is dropped, not held forever.
    writeFileSync(join(at, "leases", `${DEAD_RUNNER}-1-dead.json`), JSON.stringify({ owner: DEAD_RUNNER, label: "app gone", at: 0 }));
    expect(await gate.hold("flows lead", async () => "ran")).toBe("ran");
    expect(existsSync(join(at, "leases", `${DEAD_RUNNER}-1-dead.json`))).toBe(false);
    await expect(gate.hold("app lead", async () => { throw new Error("crashed"); })).rejects.toThrow("crashed");
    expect(readdirSync(join(at, "leases"))).toEqual([]);
    expect(gateWords(gate.facts())).toBe("provider gate: up to 1 real turn at once, 0 other sessions (cap 1, TOOLROLL_CHECK_PROVIDERS); nothing waited for a slot");
    gate.close();
    expect(gateWords({ starts: 0, cap: 4, from: "default", most: 0, others: null, waits: 0, waitedMs: 0, longest: null })).toBe("provider gate: nothing started");
  });
});
