import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { definesSchema, journeyShares, planFor, versionOnly } from "../scripts/release-check.mjs";
import { atLeast, completionProblems, installPublished, lastPublished, LONG_TEXT, missingTables, ROLLBACK_FROM, upgradeVersions } from "../scripts/upgrade-path.mjs";
import { GROUP_BYTES, browserSlots, limiter, memoryWords, parseMeminfo, parseVmStat, watchMemory } from "../scripts/check-memory.mjs";

const pkg = (version: string, dependencies: Record<string, string> = { zod: "^3.23.0" }) => JSON.stringify({ name: "toolroll", version, type: "module", dependencies }, null, 2) + "\n";
const lock = (version: string, zod = "3.23.8") => JSON.stringify({
  name: "toolroll", version, lockfileVersion: 3, requires: true,
  packages: { "": { name: "toolroll", version, dependencies: { zod: "^3.23.0" } }, "node_modules/zod": { version: zod, resolved: `https://registry.npmjs.org/zod/-/zod-${zod}.tgz` } },
}, null, 2) + "\n";

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

  test("the plan: a bump beside a change sizes to that change; without one, the version files run everything", () => {
    const changed = ["package.json", "package-lock.json", "src/store.ts", "CHANGELOG.md"];
    expect(planFor(changed, { versionBumps: ["package.json", "package-lock.json"] })).toMatchObject({ unit: "related", browser: false });
    expect(planFor(changed)).toMatchObject({ unit: "all", browser: true });
    expect(planFor(["package.json", "package-lock.json"], { versionBumps: ["package.json", "package-lock.json"] })).toMatchObject({ unit: "none", browser: false });
    expect(planFor(changed, { full: true, versionBumps: ["package.json"] })).toMatchObject({ unit: "all", browser: true });
  });
});

describe("node scripts/release-check.mjs --plan", () => {
  let dir: string | null = null;
  afterEach(() => { if (dir !== null) rmSync(dir, { recursive: true, force: true }); dir = null; });
  const script = resolve(import.meta.dirname, "../scripts/release-check.mjs");

  /** A repository at `base`, then one commit with `files`; the plan the release check prints for it. */
  const planOf = (files: Record<string, string>) => {
    dir = mkdtempSync(join(tmpdir(), "so-release-check-"));
    const git = (...argv: string[]) => execFileSync("git", ["-C", dir!, "-c", "user.name=T", "-c", "user.email=t@example.invalid", ...argv], { encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "package.json"), pkg("0.9.5")); writeFileSync(join(dir, "package-lock.json"), lock("0.9.5"));
    writeFileSync(join(dir, "store.ts"), "export const a = 1;\n");
    git("add", "."); git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
    git("add", "."); git("commit", "-qm", "change");
    return execFileSync(process.execPath, [script, "--plan", "--base", base], { cwd: dir, encoding: "utf8" }).trim();
  };

  test("a version-only package.json and lockfile change plans the sized check", () => {
    expect(planOf({ "package.json": pkg("0.9.6"), "package-lock.json": lock("0.9.6") }))
      .toMatch(/\(2 changed files\): nothing a test reads changed; only the version changed in package-lock\.json and package\.json\.$/);
  });

  test("a run: the unit tests start beside the build and wait for its outcome; the summary keeps its lines and says how long each part took", () => {
    // Stand-in scripts: the build takes a moment and the tests wait for the outcome the release check hands them.
    const scripts = {
      typecheck: "node -e \"console.log('typed')\"",
      build: "node -e \"setTimeout(() => console.log('built'), 1500)\"",
      test: "node units.cjs",
    };
    const units = "const fs = require('fs'), at = Date.now(), m = process.env.TOOLROLL_RELEASE_BUILD;\n" +
      "const wait = () => fs.existsSync(m) ? console.log(' Test Files  1 passed (1) after ' + fs.readFileSync(m, 'utf8') + ', waited ' + (Date.now() - at >= 500)) : setTimeout(wait, 50);\nwait();\n";
    const manifest = (version: string) => JSON.stringify({ name: "toolroll", version, scripts }, null, 2) + "\n";
    dir = mkdtempSync(join(tmpdir(), "so-release-check-"));
    const git = (...argv: string[]) => execFileSync("git", ["-C", dir!, "-c", "user.name=T", "-c", "user.email=t@example.invalid", ...argv], { encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "package.json"), manifest("0.9.5")); writeFileSync(join(dir, "units.cjs"), units);
    git("add", "."); git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(dir, "package.json"), manifest("0.9.6"));
    mkdirSync(join(dir, "test")); writeFileSync(join(dir, "test", "setup.ts"), "export {};\n");
    git("add", "."); git("commit", "-qm", "change");
    const out = execFileSync(process.execPath, [script, "--base", base], { cwd: dir, encoding: "utf8" });
    const summary = out.slice(out.indexOf("== summary"));
    expect(out).toContain("(2 changed files): every unit test (test/setup.ts changed); no browser journeys (nothing a page shows changed); only the version changed in package.json.");
    expect(summary.split("\n").slice(0, 4)).toEqual(["== summary", "plan: every unit test (test/setup.ts changed); no browser journeys (nothing a page shows changed); only the version changed in package.json", "unit: exit 0", " Test Files  1 passed (1) after ok, waited true"]);
    expect(summary).toMatch(/\ntook: typecheck \d+ s, build \d+ s, unit \d+ s; whole check \d+ s\npeak memory: (the check's processes [0-9.]+ GB; )?the machine [0-9.]+ GB in use of [0-9.]+ GB \(lowest available [0-9.]+ GB\)\n$/);
  });

  test("a real dependency change still runs everything", () => {
    expect(planOf({ "package.json": pkg("0.9.6", { zod: "^3.24.0" }), "package-lock.json": lock("0.9.6", "3.24.1") }))
      .toMatch(/\(2 changed files\): every unit test \(package-lock\.json changed\); browser journeys \(package-lock\.json changed\)\.$/);
  });
});

describe("the upgrade path step", () => {
  test("runs only for what an update from an installed release can trip on", () => {
    for (const file of ["src/store.ts", "src/assignment.ts", "src/assignment-status.ts", "src/dispatch.ts", "src/work-summary.ts", "src/review-switch.ts",
      "src/toolroll-update.ts", "src/desktop-update.ts", "src/desktop-update-gate.ts", "scripts/deploy-browser.mjs", "scripts/deploy-candidate.mjs", "scripts/upgrade-path.mjs"])
      expect(planFor([file]), file).toMatchObject({ upgrade: true, upgradeWhy: `${file} changed` });
    // A file that defines a table, whatever its name.
    expect(planFor(["src/spend.ts"], { schemaFiles: ["src/spend.ts"] })).toMatchObject({ upgrade: true, upgradeWhy: "src/spend.ts changed" });
    for (const changed of [["src/spend.ts"], ["src/browser/chat.ts", "src/serve.ts"], ["src/store.test.ts", "src/toolroll-update.test.ts"], ["docs/x.md", "CHANGELOG.md"]])
      expect(planFor(changed), changed.join()).toMatchObject({ upgrade: false });
    expect(planFor(["docs/x.md"], { full: true })).toMatchObject({ upgrade: true });
    expect(definesSchema("const x = 1;\nexport const SPEND_SCHEMA = `CREATE TABLE spend(id)`;")).toBe(true);
    expect(definesSchema("const SCHEMA_EPOCH = 4;\nimport { STORE_SCHEMA } from './store.js';")).toBe(false);
  });

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

  test("the last 3 published releases, oldest first; a prerelease is not one", () => {
    expect(lastPublished(["0.9.10", "0.9.4", "0.9.9-beta.1", "0.9.8", "0.10.0", "0.9.9"])).toEqual(["0.9.9", "0.9.10", "0.10.0"]);
  });

  test("0.9.11 stays on the upgrade path beside the newest three: its service could die holding the coding workspace", () => {
    expect(upgradeVersions(["0.9.8", "0.9.9", "0.9.10", "0.9.11"])).toEqual(["0.9.9", "0.9.10", "0.9.11"]);
    expect(upgradeVersions(["0.9.10", "0.9.11", "0.9.12", "0.9.13", "0.10.0"])).toEqual(["0.9.11", "0.9.12", "0.9.13", "0.10.0"]);
    // The step that frees what a killed 0.9.11 left behind runs before `toolroll update`.
    const path = readFileSync("scripts/upgrade-path.mjs", "utf8");
    const onePath = path.slice(path.indexOf("async function onePath("));
    expect(onePath.indexOf("killedCodingOwner(")).toBeGreaterThan(-1);
    expect(onePath.indexOf("killedCodingOwner(")).toBeLessThan(onePath.indexOf('step("toolroll update"'));
  });

  test("the rollback leg: from 0.9.23 on, the release reads back whole the long text the candidate wrote, after the update", () => {
    expect(ROLLBACK_FROM).toBe("0.9.23");
    expect(LONG_TEXT).toEqual({ goal: 8_000, note: 4_000 });
    expect(["0.9.11", "0.9.22", "0.9.23", "0.9.25", "0.9.26", "0.10.0"].filter(one => atLeast(one, ROLLBACK_FROM))).toEqual(["0.9.23", "0.9.25", "0.9.26", "0.10.0"]);
    const onePath = readFileSync("scripts/upgrade-path.mjs", "utf8").slice(readFileSync("scripts/upgrade-path.mjs", "utf8").indexOf("async function onePath("));
    expect(onePath.indexOf('step("rollback read"')).toBeGreaterThan(onePath.indexOf('step("inspect (updated)"'));
    expect(onePath.indexOf('step("toolroll status (rollback)"')).toBeGreaterThan(onePath.indexOf('step("rollback read"'));
  });

  test("a completed task must stay complete under the same digest, and every fresh table must exist", () => {
    const before = [{ task: "a", digest: "d1" }, { task: "b", digest: "d2" }, { task: "c", digest: "d3" }];
    expect(completionProblems(before, { a: { state: "complete", digest: "d1" }, b: { state: "complete", digest: "d2" }, c: { state: "complete", digest: "d3" } })).toEqual([]);
    expect(completionProblems(before, { a: { state: "ready-to-check", digest: null }, b: { state: "complete", digest: "other" } }))
      .toEqual(["a is ready-to-check, not complete", "b's completed result changed digest (d2 → other)", "c is gone"]);
    expect(missingTables(["build_review", "run", "task"], ["run", "task"])).toEqual(["build_review"]);
  });
});

describe("checks fit memory", () => {
  const MB = 1024 * 1024;
  test("available memory: macOS free, inactive, speculative and purgeable pages; Linux MemAvailable", () => {
    const vmStat = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:      1000.\nPages active:   9000.\nPages inactive:  2000.\nPages speculative:  500.\nPages wired down:  700.\nPages purgeable:  100.\n";
    expect(parseVmStat(vmStat)).toBe((1000 + 2000 + 500 + 100) * 16384);
    expect(parseMeminfo("MemTotal:  16000000 kB\nMemFree:  100000 kB\nMemAvailable:  8000000 kB\n")).toBe(8000000 * 1024);
    expect(parseMeminfo("MemTotal: 1 kB\n")).toBeNull();
  });

  test("browser groups: one per 400 MB available, at least 1, at most 6; shared between the two journey runs", () => {
    expect(GROUP_BYTES).toBe(400 * MB);
    expect([0, 399 * MB, 800 * MB, 1300 * MB, 2400 * MB, 64 * 1024 * MB].map(bytes => browserSlots(bytes))).toEqual([1, 1, 2, 3, 6, 6]);
    expect(journeyShares(1)).toEqual({ flows: 1, app: 1, together: false });
    expect(journeyShares(2)).toEqual({ flows: 1, app: 1, together: true });
    expect(journeyShares(6)).toEqual({ flows: 3, app: 3, together: true });
    expect(journeyShares(5)).toEqual({ flows: 2, app: 3, together: true });
  });

  test("a group starts only below the limit, and beyond the first only while there is room for it", async () => {
    let running = 0, most = 0, room = true;
    const slot = limiter(2, { room: () => room, everyMs: 5 });
    const group = (ms: number) => slot(async () => { running += 1; most = Math.max(most, running); await new Promise(done => setTimeout(done, ms)); running -= 1; });
    await Promise.all([1, 2, 3, 4, 5].map(() => group(20)));
    expect(most).toBe(2);
    // No room: one at a time, never none.
    room = false; most = 0;
    await Promise.all([1, 2, 3].map(() => group(10)));
    expect(most).toBe(1);
  });

  test("the check log records peak memory", () => {
    let free = 10 * 1024 * MB, mine = 1024 * MB;
    const watch = watchMemory({ everyMs: 60_000, total: 16 * 1024 * MB, available: () => free, tree: () => mine });
    free = 3 * 1024 * MB; mine = 5 * 1024 * MB;
    const seen = watch.stop();
    expect(seen).toEqual({ total: 16 * 1024 * MB, peakUsed: 13 * 1024 * MB, lowestAvailable: 3 * 1024 * MB, peakCheck: 5 * 1024 * MB });
    expect(memoryWords(seen)).toBe("peak memory: the check's processes 5.0 GB; the machine 13.0 GB in use of 16.0 GB (lowest available 3.0 GB)");
    expect(memoryWords({ ...seen, peakCheck: null })).toBe("peak memory: the machine 13.0 GB in use of 16.0 GB (lowest available 3.0 GB)");
    expect(readFileSync(resolve("scripts/release-check.mjs"), "utf8")).toContain("console.log(memoryWords(memory.stop()));");
  });

  test("vitest runs at most half the cores", async () => {
    const config = (await import("../vitest.config.ts")).default as { test: { maxWorkers: number } };
    expect(config.test.maxWorkers).toBeLessThanOrEqual(Math.max(1, Math.floor(availableParallelism() / 2)));
    expect(config.test.maxWorkers).toBeGreaterThanOrEqual(1);
  });
});
