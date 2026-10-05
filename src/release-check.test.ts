import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { definesSchema, journeyShares, planFor, versionOnly } from "../scripts/release-check.mjs";
import { atLeast, completionProblems, installPublished, lastPublished, LONG_TEXT, missingTables, ROLLBACK_FROM, upgradeVersions } from "../scripts/upgrade-path.mjs";
import { DEMAND, GROUP_BYTES, admissionWords, admit, browserSlots, limiter, memoryWords, openGate, parseMeminfo, parseMeminfoSwap, parseSwapUsage, parseVmStat, providerCap, sampleMachine, watchMemory } from "../scripts/check-memory.mjs";

const MB = 1024 * 1024, GB = 1024 * MB;
/** An idle machine's readings for a rehearsal (TOOLROLL_CHECK_MACHINE). */
const IDLE = { available: 32 * GB, swapUsed: 0, swapTotal: 8 * GB, providers: 0 };

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
    writeFileSync(join(dir, "machine.json"), JSON.stringify(IDLE));
    const out = execFileSync(process.execPath, [script, "--base", base], { cwd: dir, encoding: "utf8", env: { ...process.env, TOOLROLL_CHECK_MACHINE: join(dir, "machine.json"), TOOLROLL_CHECK_GATE: "", TOOLROLL_CHECK_PROVIDERS: "" } });
    const summary = out.slice(out.indexOf("== summary"));
    expect(out).toContain("(2 changed files): every unit test (test/setup.ts changed); no browser journeys (nothing a page shows changed); only the version changed in package.json.");
    expect(summary.split("\n").slice(0, 4)).toEqual(["== summary", "plan: every unit test (test/setup.ts changed); no browser journeys (nothing a page shows changed); only the version changed in package.json", "unit: exit 0", " Test Files  1 passed (1) after ok, waited true"]);
    // An idle machine: typecheck, build and the unit tests all start at once, as before; nothing waits.
    expect(out).not.toContain("waiting for room");
    expect(summary).toMatch(/\ntook: typecheck \d+ s, build \d+ s, unit \d+ s; whole check \d+ s\nadmission: ran up to 3 at a time: lowest 32\.0 GB free, swap up to 0% used; no provider turns of ours, 0 other sessions \(cap \d+, from [0-9.]+ GB memory\); nothing waited for room\npeak memory: (the check's processes [0-9.]+ GB; )?the machine [0-9.]+ GB in use of [0-9.]+ GB \(lowest available [0-9.]+ GB\)\n$/);
  });

  test("a busy machine: each part starts only when there is room, one after the other, and the summary says so", () => {
    dir = mkdtempSync(join(tmpdir(), "so-release-check-"));
    const scripts = { typecheck: "node -e \"setTimeout(() => console.log('typed'), 300)\"", build: "node -e \"setTimeout(() => console.log('built'), 300)\"", test: "node units.cjs" };
    const units = "const fs = require('fs'), m = process.env.TOOLROLL_RELEASE_BUILD;\nconsole.log(' Test Files  1 passed (1) after ' + (fs.existsSync(m) ? fs.readFileSync(m, 'utf8') : 'nothing'));\n";
    const manifest = (version: string) => JSON.stringify({ name: "toolroll", version, scripts }, null, 2) + "\n";
    const git = (...argv: string[]) => execFileSync("git", ["-C", dir!, "-c", "user.name=T", "-c", "user.email=t@example.invalid", ...argv], { encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "package.json"), manifest("0.9.5")); writeFileSync(join(dir, "units.cjs"), units);
    git("add", "."); git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    mkdirSync(join(dir, "test")); writeFileSync(join(dir, "test", "setup.ts"), "export {};\n");
    git("add", "."); git("commit", "-qm", "change");
    // 1.5 GB free and swap 97% used: room for no second start beside the first.
    writeFileSync(join(dir, "machine.json"), JSON.stringify({ available: 1.5 * GB, swapUsed: 97 * GB, swapTotal: 100 * GB, providers: 2 }));
    const out = execFileSync(process.execPath, [script, "--base", base], { cwd: dir, encoding: "utf8", env: { ...process.env, TOOLROLL_CHECK_MACHINE: join(dir, "machine.json"), TOOLROLL_CHECK_GATE: "", TOOLROLL_CHECK_PROVIDERS: "" } });
    // The build waited for the typecheck and the unit tests for the build; they still ran, and on the finished build.
    expect(out).toMatch(/^waiting for room to start build: 1\.5 GB free, swap 97% used; it needs [0-9.]+ GB$/m);
    expect(out).toMatch(/^waiting for room to start unit: /m);
    const summary = out.slice(out.indexOf("== summary"));
    expect(summary).toContain("unit: exit 0\n Test Files  1 passed (1) after ok\n");
    expect(summary).toMatch(/\nadmission: ran up to 1 at a time: lowest 1\.5 GB free, swap up to 97% used; no provider turns of ours, 2 other sessions \(cap \d+, from [0-9.]+ GB memory\); 2 starts waited [0-9.]+ (s|min) in all for room \(longest: (build|unit), 1\.5 GB free, swap 97% used; it needs [0-9.]+ GB\)\npeak memory: /);
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
    expect(LONG_TEXT).toEqual({ goal: 8_000, note: 4_000, instructions: 8_000 });
    expect(["0.9.11", "0.9.22", "0.9.23", "0.9.25", "0.9.26", "0.10.0"].filter(one => atLeast(one, ROLLBACK_FROM))).toEqual(["0.9.23", "0.9.25", "0.9.26", "0.10.0"]);
    const onePath = readFileSync("scripts/upgrade-path.mjs", "utf8").slice(readFileSync("scripts/upgrade-path.mjs", "utf8").indexOf("async function onePath("));
    expect(onePath.indexOf('step("rollback read"')).toBeGreaterThan(onePath.indexOf('step("inspect (updated)"'));
    expect(onePath.indexOf('step("toolroll status (rollback)"')).toBeGreaterThan(onePath.indexOf('step("rollback read"'));
    // The release must load the flow whose zone has the candidate's longest instructions, not only the goal and note.
    expect(onePath).toContain("couldn't load the flow whose zone has");
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

  test("swap: macOS sysctl vm.swapusage and Linux SwapTotal less SwapFree; unknown when they don't say", () => {
    expect(parseSwapUsage("vm.swapusage: total = 65536.00M  used = 64000.00M  free = 1536.00M  (encrypted)")).toEqual({ total: 64 * GB, used: 62.5 * GB });
    expect(parseSwapUsage("vm.swapusage: total = 2.00G  used = 0.50G  free = 1.50G")).toEqual({ total: 2 * GB, used: 0.5 * GB });
    expect(parseSwapUsage("")).toBeNull();
    expect(parseMeminfoSwap("MemAvailable:  8000000 kB\nSwapTotal:  2097152 kB\nSwapFree:  524288 kB\n")).toEqual({ total: 2 * GB, used: 1.5 * GB });
    expect(parseMeminfoSwap("MemAvailable:  8000000 kB\n")).toBeNull();
  });

  test("the machine's readings, or a rehearsal's; an unreadable rehearsal is a machine with no room", () => {
    const real = sampleMachine({ env: {}, available: () => 5 * GB, swap: () => ({ total: 4 * GB, used: 1 * GB }), providers: () => 3 });
    expect(real).toEqual({ available: 5 * GB, swapUsed: 1 * GB, swapTotal: 4 * GB, providers: 3 });
    expect(sampleMachine({ env: {}, available: () => 5 * GB, swap: () => null, providers: () => null })).toEqual({ available: 5 * GB, swapUsed: null, swapTotal: null, providers: null });
    const at = mkdtempSync(join(tmpdir(), "so-machine-"));
    try {
      writeFileSync(join(at, "m.json"), JSON.stringify({ available: GB, swapUsed: 9, swapTotal: 10, providers: 4 }));
      expect(sampleMachine({ env: { TOOLROLL_CHECK_MACHINE: join(at, "m.json") } })).toEqual({ available: GB, swapUsed: 9, swapTotal: 10, providers: 4 });
      expect(sampleMachine({ env: { TOOLROLL_CHECK_MACHINE: join(at, "missing.json") } })).toMatchObject({ available: 0 });
    } finally { rmSync(at, { recursive: true, force: true }); }
  });

  test("one cap on real provider turns: 1 per 5 GB of memory, 2 to 12, or TOOLROLL_CHECK_PROVIDERS", () => {
    expect([8, 16, 32, 64, 128].map(gigs => providerCap({}, gigs * GB).cap)).toEqual([2, 3, 6, 12, 12]);
    expect(providerCap({}, 64 * GB).from).toBe("64.0 GB memory");
    expect(providerCap({ TOOLROLL_CHECK_PROVIDERS: "3" }, 64 * GB)).toEqual({ cap: 3, from: "TOOLROLL_CHECK_PROVIDERS" });
    for (const bad of ["0", "-1", "2.5", "lots"]) expect(() => providerCap({ TOOLROLL_CHECK_PROVIDERS: bad }), bad).toThrow("TOOLROLL_CHECK_PROVIDERS takes a whole number, 1 or more");
  });

  test("admission: room for memory plus a reserve (more once swap is 90% used), less what recent starts will take; a provider slot; the first start always", () => {
    const now = 1_000_000, old = now - 60_000;
    const idle = { available: 32 * GB, swapUsed: 0, swapTotal: 8 * GB, providers: 0 };
    const group = DEMAND.group;
    // Nothing of ours running: it starts whatever the machine says, so a check never waits for nothing.
    expect(admit(group, { available: 0, swapUsed: 99, swapTotal: 100, providers: 50 }, [], { cap: 2, now })).toEqual({ ok: true, why: null });
    const one = { bytes: GB, providers: 1, at: old };
    expect(admit(group, idle, [one], { cap: 12, now }).ok).toBe(true);
    // Low memory: 1 GB of group plus the 1 GB reserve doesn't fit in 1.5 GB.
    expect(admit(group, { ...idle, available: 1.5 * GB }, [one], { cap: 12, now })).toEqual({ ok: false, why: "1.5 GB free, swap 0% used; it needs 2.0 GB" });
    // High swap: 3 GB free fits normally, not with swap 97% used (a 4 GB reserve).
    expect(admit(group, { ...idle, available: 3 * GB }, [one], { cap: 12, now }).ok).toBe(true);
    expect(admit(group, { ...idle, available: 3 * GB, swapUsed: 97, swapTotal: 100 }, [one], { cap: 12, now })).toEqual({ ok: false, why: "3.0 GB free, swap 97% used; it needs 5.0 GB" });
    // A start of the last 20 s hasn't taken its memory yet: it counts against what is free.
    expect(admit(group, { ...idle, available: 3 * GB }, [{ ...one, bytes: 2 * GB, at: now - 1_000 }], { cap: 12, now })).toEqual({ ok: false, why: "3.0 GB free, swap 0% used; it needs 4.0 GB" });
    // Provider slots: ours and the other sessions within the cap; our own sessions aren't counted twice.
    expect(admit(group, { ...idle, providers: 3 }, [one, one], { cap: 4, now }).ok).toBe(true);
    expect(admit(group, { ...idle, providers: 4 }, [one, one], { cap: 4, now })).toEqual({ ok: false, why: "2 provider turns of ours and 2 other sessions running, at the cap of 4" });
    expect(admit(group, { ...idle, providers: null }, [one, one, one], { cap: 3, now })).toEqual({ ok: false, why: "3 provider turns of ours and 0 other sessions running, at the cap of 3" });
    // A start that makes no provider turns doesn't need a slot.
    expect(admit(DEMAND.unit, { ...idle, providers: 40 }, [one], { cap: 2, now }).ok).toBe(true);
  });

  /** A gate on fake readings that the test changes as it goes; `owner` stands for a runner process. */
  const gateOn = (dir: string, machine: { available: number; swapUsed: number | null; swapTotal: number | null; providers: number | null }, owner: number, env: Record<string, string> = {}, lines: string[] = []) =>
    openGate({ dir, env, sample: () => ({ ...machine }), everyMs: 5, sayEveryMs: 60_000, owner, alive: pid => pid !== 4_000_000, log: line => lines.push(line) });
  const pause = (ms: number) => new Promise(done => setTimeout(done, ms));

  test("an idle machine: every group starts at once, as before, and nothing waits", async () => {
    const at = mkdtempSync(join(tmpdir(), "so-gate-"));
    try {
      const gate = gateOn(at, IDLE, 101);
      let running = 0, most = 0;
      await Promise.all([1, 2, 3, 4, 5, 6].map(n => gate.hold(`app g${n}`, DEMAND.group, async ({ waitedMs }) => { running++; most = Math.max(most, running); await pause(30); running--; return waitedMs; })));
      expect(most).toBe(6);
      expect(gate.facts()).toMatchObject({ starts: 6, most: 6, waits: 0, providers: 6, others: 0, lowest: 32 * GB, highestSwap: 0 });
      expect(admissionWords(gate.facts(101), "groups")).toMatch(/^admission: ran up to 6 groups at a time: lowest 32\.0 GB free, swap up to 0% used; up to 6 provider turns of ours, 0 other sessions \(cap \d+, from [0-9.]+ GB memory\); nothing waited for room$/);
    } finally { rmSync(at, { recursive: true, force: true }); }
  });

  test("two runners share one gate: one provider cap between them, the waits said and recorded, a dead runner's leases dropped", async () => {
    const at = mkdtempSync(join(tmpdir(), "so-gate-"));
    try {
      const machine = { ...IDLE };
      const lines: string[] = [];
      const flows = gateOn(at, machine, 201, { TOOLROLL_CHECK_PROVIDERS: "2" }, lines);
      // The second opener takes the cap the first chose, whatever its own environment says.
      const app = gateOn(at, machine, 202, { TOOLROLL_CHECK_PROVIDERS: "9" }, lines);
      expect(app.cap).toBe(2);
      let running = 0, most = 0;
      const group = (gate: typeof flows, label: string) => gate.hold(label, DEMAND.group, async () => { running++; most = Math.max(most, running); await pause(40); running--; });
      await Promise.all([group(flows, "flows a"), group(app, "app a"), group(flows, "flows b"), group(app, "app b"), group(app, "app c")]);
      expect(most).toBe(2);
      expect(lines.some(line => /^waiting for room to start (flows|app) [abc]: 2 provider turns of ours and 0 other sessions running, at the cap of 2$/.test(line))).toBe(true);
      const facts = flows.facts();
      expect(facts).toMatchObject({ starts: 5, most: 2, providers: 2 });
      expect(facts.waits).toBeGreaterThanOrEqual(3);
      expect(admissionWords(facts)).toMatch(/; up to 2 provider turns of ours, 0 other sessions \(cap 2, from TOOLROLL_CHECK_PROVIDERS\); [3-5] starts waited [0-9.]+ s in all for room \(longest: .+, 2 provider turns of ours and 0 other sessions running, at the cap of 2\)$/);

      // A runner killed outright left its lease behind: it is dropped, not held forever.
      writeFileSync(join(at, "leases", "4000000-1-dead.json"), JSON.stringify({ owner: 4_000_000, label: "app gone", bytes: GB, providers: 2, at: 0 }));
      await flows.hold("flows c", DEMAND.group, async () => undefined);
      expect(existsSync(join(at, "leases", "4000000-1-dead.json"))).toBe(false);
      // A start whose body throws still lets go of its lease.
      await expect(app.hold("app d", DEMAND.group, async () => { throw new Error("crashed"); })).rejects.toThrow("crashed");
      expect(readdirSync(join(at, "leases"))).toEqual([]);

      // Low memory: the second start waits until there is room, then starts.
      machine.available = 1.2 * GB;
      let second = false;
      const first = flows.hold("flows d", DEMAND.group, async () => { await pause(60); machine.available = 16 * GB; await pause(30); });
      await pause(5);
      await app.hold("app e", DEMAND.group, async ({ waitedMs }) => { second = true; expect(waitedMs).toBeGreaterThanOrEqual(40); });
      await first;
      expect(second).toBe(true);
      expect(lines).toContain("waiting for room to start app e: 1.2 GB free, swap 0% used; it needs 3.0 GB");
      flows.close(); app.close();
    } finally { rmSync(at, { recursive: true, force: true }); }
  });

  test("vitest runs at most half the cores", async () => {
    const config = (await import("../vitest.config.ts")).default as { test: { maxWorkers: number } };
    expect(config.test.maxWorkers).toBeLessThanOrEqual(Math.max(1, Math.floor(availableParallelism() / 2)));
    expect(config.test.maxWorkers).toBeGreaterThanOrEqual(1);
  });
});
