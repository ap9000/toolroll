import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { journeyEnv, upgradeChanges, needsUpgrade, partRunner, planFor, releaseTagProblem, versionOnly } from "../scripts/release-check.mjs";
import { historicalSchema, atLeast, completionProblems, FIRST_RELEASE, installPublished, lastPublished, LONG_TEXT, missingTables, ROLLBACK_FROM, selectedVersions, upgradeLanes, upgradeVersions } from "../scripts/upgrade-path.mjs";
import { openGate, providerCap } from "../scripts/provider-gate.mjs";
import { ciJobNames, ciSucceeded, macUnitFiles, passedCandidateCI } from "../scripts/release-check-ci.mjs";
import { fakePid } from "../test/fake-pid.js";

const pkg = (version: string, dependencies: Record<string, string> = { zod: "^3.23.0" }) => JSON.stringify({ name: "toolroll", version, type: "module", dependencies }, null, 2) + "\n";
const lock = (version: string, zod = "3.23.8") => JSON.stringify({
  name: "toolroll", version, lockfileVersion: 3, requires: true,
  packages: { "": { name: "toolroll", version, dependencies: { zod: "^3.23.0" } }, "node_modules/zod": { version: zod, resolved: `https://registry.npmjs.org/zod/-/zod-${zod}.tgz` } },
}, null, 2) + "\n";
const gitIn = (dir: string, ...argv: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@example.invalid", ...argv], { encoding: "utf8" }).trim();
/** A repository in `dir` with `base` committed, then one commit with `change`; the base commit. */
const repoWith = (dir: string, base: Record<string, string>, change: Record<string, string>) => {
  const git = (...argv: string[]) => gitIn(dir, ...argv);
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
/** These fixture repositories have no origin: compare with their own tags. */
// The machine the check budgets for, made exact (24 quiet cores: 8 unit workers, 4 app and 2 flows lanes, 3 upgrade workers).
const LOCAL_TAGS = { ...process.env, TOOLROLL_RELEASE_LOCAL_TAGS: "1", TOOLROLL_CHECK_CORES: "24", TOOLROLL_CHECK_LOAD: "0", TOOLROLL_UPGRADE_WORKERS: "" };

describe("a release's version bump", () => {

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
    for (const file of ["src/lead.ts", "src/lead-tools.ts", "src/subscription-chat.ts", "src/planner.ts", "src/builder.ts", "src/provider.ts", "src/invoke.ts", "src/subagents.ts", "src/flow-sort.ts", "src/task-sizing.ts"])
      expect(planFor([file]), file).toEqual({ checks: true, real: true, why: `every unit test and every scripted browser journey; the real-model journeys and what they need (${file} changed: model-facing)` });
    expect(planFor(["src/lead.test.ts"]).real).toBe(false);
    expect(planFor(["src/browser/app.tsx"], { real: true }).why).toBe("every unit test and every scripted browser journey; the real-model journeys and what they need (--real)");
    expect(planFor(["docs/guide/flows.md"], { real: true })).toEqual({ checks: false, real: true, why: "no unit tests or scripted journeys (nothing a test reads changed); the real-model journeys and what they need (--real)" });
    expect(planFor([], { full: true })).toEqual({ checks: true, real: true, why: "a full check: every unit test, every scripted and real-model browser journey" });
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
      return execFileSync(process.execPath, [script, "--plan", "--base", base], { cwd: at, encoding: "utf8", env: LOCAL_TAGS }).trim();
    };
    expect(planOf({ "package.json": pkg("0.9.6"), "package-lock.json": lock("0.9.6") }))
      .toMatch(/\(2 changed files\): nothing a test reads changed; only the version changed in package-lock\.json and package\.json\.$/);
    rmSync(dir!, { recursive: true, force: true });
    expect(planOf({ "package.json": pkg("0.9.6", { zod: "^3.24.0" }), "package-lock.json": lock("0.9.6", "3.24.1") }))
      .toMatch(/\(2 changed files\): every unit test\.$/);
  });

  test.each([false, true])("the latest reachable release tag excludes already released code (annotated: %s)", annotated => {
    const at = fresh();
    const base = repoWith(at, { "src/lead.ts": "export {};\n" }, { "src/lead.ts": "export const released = true;\n" });
    gitIn(at, "tag", "v0.9.4", base);
    gitIn(at, "tag", ...(annotated ? ["-a", "-m", "release"] : []), "v0.9.5");
    // A newer release on another line of development is not this candidate's baseline.
    const unrelated = gitIn(at, "commit-tree", "HEAD^{tree}", "-p", base, "-m", "another release");
    gitIn(at, "tag", "v99.0.0", unrelated);
    writeFileSync(join(at, "CHANGELOG.md"), "# Release notes\n");
    gitIn(at, "add", "."); gitIn(at, "commit", "-qm", "notes");
    gitIn(at, "tag", "candidate-only");
    const out = execFileSync(process.execPath, [script, "--plan"], { cwd: at, encoding: "utf8", env: LOCAL_TAGS });
    expect(out).toContain("Release check against v0.9.5 (1 changed files): only docs, evidence or design notes changed.");
    const override = execFileSync(process.execPath, [script, "--plan", "--base", base], { cwd: at, encoding: "utf8", env: LOCAL_TAGS });
    expect(override).toContain(`Release check against ${base} (2 changed files): every unit test.`);
  });

  test("a checkout missing origin's newer release tags fetches them, and is refused when it still can't reach them", () => {
    expect(releaseTagProblem("0.9.62", "v0.9.61", ["v0.9.6", "v0.9.59", "v0.9.60", "v0.9.61"])).toBeNull();
    expect(releaseTagProblem("0.9.62", "v0.9.59", ["v0.9.59", "v0.9.60", "v0.9.61"])).toMatch(/newest release tag is v0\.9\.59, but origin has v0\.9\.61/);
    expect(releaseTagProblem("0.9.62", null, ["v0.9.61"])).toMatch(/newest release tag is none/);
    // A tag of this very version (a re-run after tagging) or a newer line isn't the release before it.
    expect(releaseTagProblem("0.9.62", "v0.9.61", ["v0.9.61", "v0.9.62", "v1.0.0"])).toBeNull();
    expect(releaseTagProblem("0.9.62", "v0.9.61", null)).toMatch(/Couldn't read origin's release tags/);
    expect(releaseTagProblem(null, null, null)).toBeNull();
    // For real: origin has v0.9.60 and v0.9.61; the checkout was cloned before them and its own tags stop at v0.9.59.
    const at = fresh();
    const origin = join(at, "origin.git"), work = join(at, "work");
    mkdirSync(work);
    const first = repoWith(work, { "package.json": pkg("0.9.59") }, { "package.json": pkg("0.9.60") });
    gitIn(work, "tag", "v0.9.59", first);
    execFileSync("git", ["clone", "-q", "--bare", work, origin]);
    gitIn(work, "remote", "add", "origin", origin);
    gitIn(work, "tag", "v0.9.60");
    writeFileSync(join(work, "package.json"), pkg("0.9.61")); gitIn(work, "commit", "-qam", "0.9.61"); gitIn(work, "tag", "v0.9.61");
    gitIn(work, "push", "-q", "origin", "HEAD:refs/heads/main", "v0.9.60", "v0.9.61");
    writeFileSync(join(work, "package.json"), pkg("0.9.62")); gitIn(work, "commit", "-qam", "0.9.62");
    for (const tag of ["v0.9.60", "v0.9.61"]) gitIn(work, "tag", "-d", tag);
    const plan = () => execFileSync(process.execPath, [script, "--plan"], { cwd: work, encoding: "utf8", env: { ...process.env, TOOLROLL_RELEASE_LOCAL_TAGS: "" } });
    // The best-effort fetch brings the tags back: it compares with v0.9.61.
    expect(plan()).toContain("Release check against v0.9.61");
    // When the fetch can't bring them (the tag isn't reachable here) or origin can't be read, it stops in words.
    for (const tag of ["v0.9.60", "v0.9.61"]) gitIn(work, "tag", "-d", tag);
    gitIn(work, "remote", "set-url", "origin", join(at, "missing.git"));
    expect(() => execFileSync(process.execPath, [script, "--plan"], { cwd: work, encoding: "utf8", stdio: "pipe", env: { ...process.env, TOOLROLL_RELEASE_LOCAL_TAGS: "" } })).toThrow(/Couldn't read origin's release tags/);
  });

  test("upgrade comparison uses the last release tag even when --base points at HEAD, including local edits", () => {
    const at = fresh();
    const base = repoWith(at, { "src/store.ts": "export const old = true;", "scripts/upgrade-path.mjs": "" }, { "src/store.ts": "export const changed = true;" });
    gitIn(at, "tag", "v0.9.60", base);
    const plan = () => execFileSync(process.execPath, [script, "--plan", "--base", "HEAD"], { cwd: at, encoding: "utf8", env: LOCAL_TAGS });
    expect(plan()).toContain("upgrade path: last five release tags, baseline and 0.5.0");
    gitIn(at, "tag", "v0.9.61");
    expect(plan()).not.toContain("upgrade path:");
    writeFileSync(join(at, "src/store.ts"), "export const local = true;");
    expect(plan()).toContain("upgrade path:");
    const full = execFileSync(process.execPath, [script, "--plan", "--full"], { cwd: at, encoding: "utf8", env: LOCAL_TAGS });
    expect(full).toContain("the upgrade path from every release since 0.5.0");
  });

  test("a run: the unit tests start beside the build and wait for its outcome; the summary keeps its lines and says how long each part took", () => {
    // The stand-in tests wait for the outcome the release check hands them: seeing "ok" means they waited for the build.
    const scripts = { typecheck: "node -e \"console.log('typed')\"", build: "node -e \"console.log('built')\"", "test:all": "node units.cjs" };
    const units = "const fs = require('fs'), m = process.env.TOOLROLL_RELEASE_BUILD;\n" +
      "const wait = () => fs.existsSync(m) ? console.log(' Test Files  1 passed (1) after ' + fs.readFileSync(m, 'utf8')) : setTimeout(wait, 20);\nwait();\n";
    const manifest = (version: string) => JSON.stringify({ name: "toolroll", version, scripts }, null, 2) + "\n";
    const at = fresh();
    const base = repoWith(at, { "package.json": manifest("0.9.5"), "units.cjs": units }, { "package.json": manifest("0.9.6"), "test/setup.ts": "export {};\n" });
    const out = execFileSync(process.execPath, [script, "--base", base], { cwd: at, encoding: "utf8", env: { ...LOCAL_TAGS, TOOLROLL_CHECK_GATE: "", TOOLROLL_CHECK_PROVIDERS: "" } });
    expect(out).toContain("(2 changed files): every unit test; only the version changed in package.json.");
    const summary = out.slice(out.indexOf("== summary"));
    expect(summary).toContain("unit: exit 0\n Test Files  1 passed (1) after ok");
    expect(summary).toMatch(/\ntook: typecheck \d+ s, build \d+ s, unit \d+ s; whole check \d+ s\n$/);
  });

  test("exact CI reuse runs macOS files locally, while --full still invokes the entire unit suite", () => {
    const at = fresh();
    const manifest = JSON.stringify({ name: "fixture", scripts: { typecheck: "node -e 0", build: "node -e 0", "test:all": "node units.cjs" } });
    const gh = `#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const common = { event: "push", head_sha: sha, status: 'completed', conclusion: 'success' };
console.log(JSON.stringify(process.argv.at(-1).includes('/attempts/')
  ? [{ jobs: [{ ...common, name: 'units' }] }]
  : [{ workflow_runs: [{ ...common, id: 1, run_attempt: 1, path: '.github/workflows/ci.yml' }] }]));
`;
    const base = repoWith(at, { "package.json": manifest, "units.cjs": "console.log('LOCAL_UNITS ' + JSON.stringify(process.argv.slice(2)))",
      ".github/workflows/ci.yml": "jobs:\n  test:\n    name: units\n", "tools/gh": gh,
      "src/native.test.ts": "// macOS-only test fixture", "src/common.test.ts": "// portable test fixture" }, { "src/code.ts": "export {};" });
    // Executable mode is part of this fixture's candidate, so it remains clean for CI reuse.
    chmodSync(join(at, "tools/gh"), 0o755);
    gitIn(at, "add", "."); gitIn(at, "commit", "-qm", "executable fixture");
    const env = { ...LOCAL_TAGS, PATH: `${join(at, "tools")}:${process.env.PATH}` };
    const normal = execFileSync(process.execPath, [script, "--base", base], { cwd: at, env, encoding: "utf8" });
    expect(normal).toContain("unit suite reused:");
    if (process.platform === "darwin") expect(normal).toContain('LOCAL_UNITS ["--run","--reporter=dot","--maxWorkers=8","src/native.test.ts"]');
    else expect(normal).not.toContain("LOCAL_UNITS");
    const full = execFileSync(process.execPath, [script, "--base", base, "--full"], { cwd: at, env, encoding: "utf8" });
    expect(full).not.toContain("unit suite reused:");
    expect(full).toContain('LOCAL_UNITS ["--run","--reporter=dot","--maxWorkers=8"]');
  });

  /** A checkout with journey scripts and a stand-in runner that logs how it is asked to run (and whether it was handed
   * a provider gate), then one commit changing `files`; the release check's output, and each journey run it started. */
  const checkOf = (files: Record<string, string>, extra: string[] = [], build = "node -e 0", baseline: "explicit" | "release" | "missing" = "explicit") => {
    const at = fresh();
    const runner = "import { appendFileSync } from 'node:fs';\nappendFileSync('journey-runs.jsonl', JSON.stringify({ argv: process.argv.slice(2), gate: process.env.TOOLROLL_CHECK_GATE ?? null }) + '\\n');\nconsole.log('Model calls: 4 scripted, 0 real turns');\n";
    const base = repoWith(at, {
      "scripts/e2e-parallel.mjs": runner, "scripts/flows-e2e.mjs": "", "scripts/app-e2e.mjs": "",
      "package.json": JSON.stringify({ name: "toolroll", version: "0.9.5", scripts: { typecheck: "node -e 0", build, "test:all": "node -e 0 --" } }, null, 2) + "\n",
      "src/browser/app.tsx": "export {};\n", "src/lead.ts": "export {};\n",
    }, files);
    if (baseline === "release") {
      gitIn(at, "tag", "v0.9.5", base);
      // Main already has the code; the release PR changes only the version.
      gitIn(at, "update-ref", "refs/remotes/origin/main", "HEAD");
      const manifest = JSON.parse(readFileSync(join(at, "package.json"), "utf8"));
      manifest.version = "0.9.6";
      writeFileSync(join(at, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
      gitIn(at, "add", "."); gitIn(at, "commit", "-qm", "version bump");
      expect(gitIn(at, "diff", "--name-only", "origin/main", "HEAD")).toBe("package.json");
    }
    let out: string;
    try { out = execFileSync(process.execPath, [script, ...(baseline === "explicit" ? ["--base", base] : []), ...extra], { cwd: at, encoding: "utf8", env: { ...LOCAL_TAGS, NODE_OPTIONS: "", TOOLROLL_CHECK_GATE: "", TOOLROLL_CHECK_PROVIDERS: "" } }); } catch (error) { out = (error as { stdout: string }).stdout; }
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

  test.each(["src/browser/app.tsx", "src/lead.ts"])("a version-only release runs units and journeys for %s changed since its tag", file => {
    const { out, runs } = checkOf({ [file]: "export const changed = 1;\n" }, [], "node -e 0", "release");
    expect(out).toContain("Release check against v0.9.5 (2 changed files): every unit test and every scripted browser journey");
    expect(out).toContain("\nunit: exit 0\n");
    expect(runs).toEqual(file === "src/lead.ts" ? [REAL[0], SCRIPTED[0], REAL[1], SCRIPTED[1]] : SCRIPTED);
  });

  test("without a reachable release tag, even docs run the full suite", () => {
    const { out, runs } = checkOf({ "CHANGELOG.md": "# Notes\n" }, [], "node -e 0", "missing");
    expect(out).toContain("Release check against nothing (no reachable v* release tag)");
    expect(out).toContain("a full check");
    expect(out).toContain("\nunit: exit 0\n");
    expect(runs).toEqual([REAL[0], SCRIPTED[0], REAL[1], SCRIPTED[1]]);
  });

  test("a model-facing change and --real add the real-model groups under one provider gate; docs alone run no journey", () => {
    const model = checkOf({ "src/lead.ts": "export const changed = 1;\n" });
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
    gate.close();
  });
});


describe("release check speed without weakening checks", () => {
  test("upgrade comparison covers store, baseline, migrations and schema; unreadable and full run", () => {
    for (const path of ["src/store.ts", "src/store-baseline.ts", "src/store/rows.ts", "src/migrations/121.ts", "src/migration-120.ts", "src/schema.sql"])
      expect(needsUpgrade([path]), path).toBe(true);
    expect(needsUpgrade(["package.json", "src/browser/app.tsx"], false, ["package.json"])).toBe(false);
    expect(needsUpgrade(["package.json"])).toBe(true);
    for (const path of ["src/chat-migration.ts", "src/contracts/chat-tables.ts", "src/storage.ts", "src/spend.ts", "src/retention.ts", "src/action-ledger.ts", "src/coding-workspace.ts", "src/ledger-chain.ts", "src/policy.ts", "src/toolroll-update.ts", "src/desktop-update.ts", "src/new-module.ts", "scripts/suite-lifecycle.mjs", "scripts/upgrade-path.mjs"])
      expect(needsUpgrade([path]), path).toBe(true);
    expect(needsUpgrade(["docs/TESTING.md", "src/browser/app.tsx", "src/server/console.css", "src/store.test.ts", "test/fixture.ts", "scripts/app-e2e.mjs"])).toBe(false);
    expect(needsUpgrade([])).toBe(false);
    expect(needsUpgrade(null)).toBe(true);
    expect(needsUpgrade([], true)).toBe(true);
  });

  test("upgrade diff includes untracked schema code and fails closed on unreadable discovery", () => {
    const root = mkdtempSync(join(tmpdir(), "so-upgrade-diff-"));
    try {
      repoWith(root, { "src/chat-migration.ts": "// old" }, { "docs/note.md": "notes" });
      gitIn(root, "tag", "v0.9.61");
      const git = (...args: string[]) => gitIn(root, ...args);
      expect(upgradeChanges("v0.9.61", git)).toEqual([]);
      writeFileSync(join(root, "src/new-tables.ts"), "const sql = 'CREATE TABLE extra (id TEXT)';");
      expect(upgradeChanges("v0.9.61", git)).toEqual(["src/new-tables.ts"]);
      expect(needsUpgrade(upgradeChanges("v0.9.61", git))).toBe(true);
      writeFileSync(join(root, "src/chat-migration.ts"), "// changed");
      expect(upgradeChanges("v0.9.61", git)).toEqual(["src/chat-migration.ts", "src/new-tables.ts"]);
      expect(upgradeChanges("missing-tag", git)).toBeNull();
      expect(upgradeChanges(null, git)).toBeNull();
      expect(upgradeChanges("v0.9.61", (...args: string[]) => { if (args[0] === "ls-files") throw Error("unreadable"); return ""; })).toBeNull();
      // A migration file moved somewhere that alone wouldn't run upgrades still lists its old path.
      rmSync(join(root, "src/new-tables.ts"));
      gitIn(root, "checkout", "--", "src/chat-migration.ts");
      gitIn(root, "mv", "src/chat-migration.ts", "docs/chat-migration.md");
      expect(upgradeChanges("v0.9.61", git)).toEqual(["docs/chat-migration.md", "src/chat-migration.ts"]);
      expect(needsUpgrade(upgradeChanges("v0.9.61", git))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("historical schema parsing reads more than one MB and rejects missing versions", () => {
    const root = mkdtempSync(join(tmpdir(), "so-schema-buffer-"));
    try {
      const base = repoWith(root, { "src/store.ts": "//" + "x".repeat(1_500_000) + "\nexport const SCHEMA_VERSION = 107;" }, { "src/store.ts": "export {};" });
      expect(historicalSchema(root, base)).toBe(107);
      expect(() => historicalSchema(root, "HEAD")).toThrow("Unreadable schema version");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("only scripted release journeys disable retries and shorten polling", () => {
    const env = { TOOLROLL_CHECK_SCRIPTED_TIMEOUT_SECONDS: "75", TOOLROLL_RELEASE_FAIL_FAST: "1", TOOLROLL_RELEASE_SCRIPTED_TIMEOUT_SECONDS: "1" };
    expect(journeyEnv("scripted", null, env)).toEqual({ TOOLROLL_RELEASE_FAIL_FAST: "1", TOOLROLL_RELEASE_SCRIPTED_TIMEOUT_SECONDS: "75" });
    expect(journeyEnv("scripted", null, {})).toMatchObject({ TOOLROLL_RELEASE_SCRIPTED_TIMEOUT_SECONDS: "90" });
    expect(journeyEnv("real", { dir: "gate" }, env)).toEqual({ TOOLROLL_RELEASE_FAIL_FAST: undefined, TOOLROLL_RELEASE_SCRIPTED_TIMEOUT_SECONDS: undefined, TOOLROLL_CHECK_GATE: "gate" });
  });

  test("upgrade sample deduplicates baseline and first release, full retains all, lanes respect CPU", () => {
    const tags = ["v0.5.0", ...Array.from({ length: 8 }, (_, i) => `v0.9.${i}`), "v1.0.0-beta"];
    const schema = (tag: string) => tag === "v0.5.0" ? 107 : tag === "v0.9.1" ? 108 : 120;
    expect(selectedVersions(tags, 107, schema)).toEqual(["0.5.0", "0.9.3", "0.9.4", "0.9.5", "0.9.6", "0.9.7"]);
    expect(selectedVersions(tags, 108, schema)).toEqual(["0.5.0", "0.9.1", "0.9.3", "0.9.4", "0.9.5", "0.9.6", "0.9.7"]);
    expect(selectedVersions(tags, 107, schema, { full: true })).toHaveLength(9);
    // A tag that never reached npm is skipped, and the newest five published releases still count.
    const unpublished = tags.map(tag => tag.replace(/^v/, "")).filter(version => version !== "0.9.7");
    expect(selectedVersions(tags, 107, schema, { published: unpublished })).toEqual(["0.5.0", "0.9.2", "0.9.3", "0.9.4", "0.9.5", "0.9.6"]);
    expect(() => selectedVersions(tags, 999, schema)).toThrow("No release tag");
    expect(upgradeLanes("8", 4)).toBe(3);
    expect(upgradeLanes("8", 1)).toBe(1);
    expect(() => upgradeLanes("0", 4)).toThrow();
  });

  test("CI requires every workflow job on exactly the candidate, with no skipped or pending jobs", () => {
    const expected = ciJobNames(readFileSync(resolve(import.meta.dirname, "../.github/workflows/ci.yml"), "utf8"));
    expect(expected).toContain("node 22 · ubuntu-latest");
    expect(expected).toContain("node 24 · ubuntu-latest");
    const sha = "a".repeat(40);
    const run = { event: "push", head_sha: sha, path: ".github/workflows/ci.yml", status: "completed", conclusion: "success" };
    const jobs = expected.map(name => ({ name, head_sha: sha, status: "completed", conclusion: "success" }));
    expect(ciSucceeded(sha, run, jobs, expected)).toBe(true);
    for (const event of ["pull_request", "pull_request_target", "workflow_dispatch", undefined])
      expect(ciSucceeded(sha, { ...run, event }, jobs, expected)).toBe(false);
    expect(ciSucceeded("b".repeat(40), run, jobs, expected)).toBe(false);
    expect(ciSucceeded(sha, { ...run, path: ".github/workflows/other.yml" }, jobs, expected)).toBe(false);
    for (const conclusion of ["skipped", "failure", "cancelled", null])
      expect(ciSucceeded(sha, run, [{ ...jobs[0], conclusion }, ...jobs.slice(1)], expected)).toBe(false);
    expect(ciSucceeded(sha, run, [{ ...jobs[0], status: "in_progress" }, ...jobs.slice(1)], expected)).toBe(false);
    expect(ciSucceeded(sha, run, [{ ...jobs[0], head_sha: "b".repeat(40) }, ...jobs.slice(1)], expected)).toBe(false);
    expect(ciSucceeded(sha, run, jobs.slice(1), expected)).toBe(false);
    expect(ciSucceeded(sha, run, [...jobs, jobs[0]], expected)).toBe(false);
  });

  test("CI API is pinned by sha and latest attempt; unknown, dirty and full fall back", () => {
    const sha = "a".repeat(40), requests: string[][] = [];
    const workflow = () => "jobs:\n  test:\n    name: units\n";
    const run = { event: "push", id: 7, run_attempt: 2, head_sha: sha, path: ".github/workflows/ci.yml", status: "completed", conclusion: "success" };
    const exec = (_: string, args: string[]) => {
      requests.push(args);
      return JSON.stringify(args.at(-1)!.includes("/attempts/") ? [{ jobs: [{ name: "units", head_sha: sha, status: "completed", conclusion: "success" }] }] : [{ workflow_runs: [run] }]);
    };
    const git = (...args: string[]) => args[0] === "status" ? "" : sha;
    expect(passedCandidateCI({ git, exec, workflow }).passed).toBe(true);
    expect(requests[0].at(-1)).toContain(`head_sha=${sha}`);
    expect(requests[1].at(-1)).toContain("/runs/7/attempts/2/jobs");
    run.event = "pull_request";
    expect(passedCandidateCI({ git, exec, workflow }).passed).toBe(false);
    run.event = "push";
    expect(passedCandidateCI({ git, exec: () => { throw Error("offline"); }, workflow }).passed).toBe(false);
    expect(passedCandidateCI({ git: () => "dirty", exec, workflow }).passed).toBe(false);
    expect(passedCandidateCI({ full: true, git, exec, workflow }).passed).toBe(false);
    expect(() => ciJobNames("jobs:\n  unit:\n    strategy:\n      matrix:\n        include: []\n")).toThrow();
  });

  test("CI reuse keeps native macOS tests including sandbox and browser coverage", () => {
    const files = macUnitFiles(resolve(import.meta.dirname));
    for (const file of ["agent-fence.slow.test.ts", "boot-identity.test.ts", "scout-browser.test.ts", "desktop-update.recovery.slow.test.ts"])
      expect(files).toContain(resolve(import.meta.dirname, file));
  });

  test("passing unit regressions can print a synthetic journey failure without failing the outer check", async () => {
    const dir = mkdtempSync(join(tmpdir(), "so-synthetic-failure-"));
    try {
      const parts = partRunner(dir);
      const unit = await parts.run("unit", process.execPath, ["-e", "console.error('TOOLROLL_CHECK_FAILURE fixture: exit 1')"]);
      expect(unit.code).toBe(0);
      expect(parts.failure()).toBeNull();
      const app = await parts.run("app", process.execPath, ["-e", "console.error('TOOLROLL_CHECK_FAILURE alpha: exit 1'); setInterval(() => {}, 1000)"]);
      expect(app.code).not.toBe(0);
      expect(parts.failure()).toBe("app: alpha: exit 1");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("first hard failure cancels an active sibling and prevents later parts from starting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "so-fast-failure-"));
    try {
      const parts = partRunner(dir, { graceMs: 10, timeoutMs: 10_000 });
      const hang = parts.run("unit", process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
      const fail = parts.run("app", process.execPath, ["-e", "console.error('journey failed'); process.exit(7)"]);
      const [stopped, failed] = await Promise.all([hang, fail]);
      expect(failed.code).toBe(7);
      expect(stopped.code).not.toBe(0);
      expect(parts.failure()).toBe("app: exit 7");
      expect(parts.signal.aborted).toBe(true);
      const late = await parts.run("late", process.execPath, ["-e", "throw Error('must never run')"]);
      expect(late.code).toBe(130);
      expect(readFileSync(late.log, "utf8")).toBe("");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // Release check 3261: killed at five minutes, it left only its header, because each part's output was printed only
  // once the whole check ended. Now every line reaches the check's stdout as it comes, tagged with its part, and each
  // part's end is recorded with its start, exit code, signal, timeout and cancellation apart.
  test("each part's output is streamed as it comes, tagged; its end records start, exit, signal, timeout and stop apart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "so-streamed-"));
    try {
      const streamed: string[] = [], said: string[] = [];
      const parts = partRunner(dir, { failFast: false, graceMs: 10, stream: text => { streamed.push(text); }, say: line => { said.push(line); } });
      let seen = false;
      const killed = parts.run("unit", process.execPath, ["-e", "console.log('first line'); process.stdout.write('dots···'); setTimeout(() => process.kill(process.pid, 'SIGKILL'), 300)"]);
      // Before the part ends, its first line is already out.
      for (let n = 0; n < 100 && !seen; n++) { await new Promise(done => setTimeout(done, 20)); seen = streamed.join("").includes("[unit] first line\n"); }
      expect(seen).toBe(true);
      const ended = await killed;
      expect(ended).toMatchObject({ code: 137, signal: "SIGKILL", timedOut: false, stopped: false, cancelled: false });
      expect(streamed.join("")).toContain("[unit] dots···\n");
      expect(parts.failure()).toBe("unit: exit 137 (ended by SIGKILL)");
      expect(said).toContainEqual(expect.stringMatching(/^== unit ended: started \d{4}-\d\d-\d\dT[^,]+, exit 137, signal SIGKILL, timed out no, stopped no, took \d+ s$/));
      expect(said).toContainEqual(expect.stringContaining("== unit failed (exit 137, ended by SIGKILL)"));
      const missing = await parts.run("app", join(dir, "no-such-program"), []);
      expect(missing).toMatchObject({ spawnFailed: true });
      expect(said).toContainEqual(expect.stringContaining("== app ended: started"));
      expect(said.find(line => line.startsWith("== app ended"))).toContain("could not start");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("release-only gate reservation lets four turns start even with other sessions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "so-reserved-gate-"));
    const gate = openGate({ dir, env: {}, reserve: true, sessions: () => 20, everyMs: 1 });
    const peer = openGate({ dir, sessions: () => 20, everyMs: 1 });
    const started = Promise.withResolvers<void>(), end = Promise.withResolvers<void>();
    let count = 0;
    try {
      const turns = Array.from({ length: 4 }, (_, i) => (i % 2 ? gate : peer).hold(String(i), async () => {
        if (++count === 4) started.resolve();
        await end.promise;
      }));
      await started.promise;
      expect(gate.facts().most).toBe(4);
      end.resolve(); await Promise.all(turns);
    } finally { end.resolve(); gate.close(); peer.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
