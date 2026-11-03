/**
 * The CI unit suite's shards (scripts/ci-shards.mjs, docs/plans/pipeline-speed.md part A): a required "node N ·
 * ubuntu-latest" check passes only when every shard's own Vitest report passed, its counts agree with its results, it
 * executed tests, it skipped only what the trusted base allows, and together the shards ran every test file the include
 * policy finds exactly once. Each way a shard set can fall short is one row (Codex review round 1, finding 1).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { INCLUDE, inventory, laneFiles, LANES, linuxSkipsProblem, NATIVE_PROBES, readReport, reportsIn, shardsProblem } from "../scripts/ci-shards.mjs";
import { planShards } from "../scripts/ci-timings.mjs";

const scratch = mkdtempSync(join(tmpdir(), "ci-shards-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const root = join(scratch, "candidate"), base = join(scratch, "base");
const write = (at: string, file: string, text: string) => { mkdirSync(join(at, file, ".."), { recursive: true }); writeFileSync(join(at, file), text); };
// The base revision: a file that may skip (it says so), and one that never does.
write(base, "src/a.test.ts", "test('a', () => {});\n");
write(base, "src/native.test.ts", "test.skipIf(process.platform !== 'linux')('native', () => {});\n");
write(base, "test/attacks/d.test.ts", "test('d', () => {});\n");

type Assertion = { status: string };
type FileResult = { name: string; status: string; assertionResults: Assertion[] };
const file = (name: string, passed = 2, skipped = 0, status = passed > 0 ? "passed" : "skipped"): FileResult =>
  ({ name: join(root, name), status, assertionResults: [...Array(passed).fill({ status: "passed" }), ...Array(skipped).fill({ status: "skipped" })] });
const report = (files: FileResult[], extra: Record<string, unknown> = {}) => {
  const all = files.flatMap(one => one.assertionResults);
  return { success: true, numFailedTests: 0, numFailedTestSuites: 0, numTotalTests: all.length, numPassedTests: all.filter(one => one.status === "passed").length,
    numPendingTests: all.filter(one => one.status !== "passed").length, numTodoTests: 0, testResults: files, ...extra };
};
const listed = ["src/a.test.ts", "src/b.test.ts", "src/native.test.ts", "test/attacks/d.test.ts"];
const good = () => new Map<number, unknown>([[1, report([file("src/a.test.ts"), file("src/native.test.ts", 1, 3)])], [2, report([file("src/b.test.ts"), file("test/attacks/d.test.ts")])]]);
const problem = (reports: Map<number, unknown>, files = listed) => shardsProblem(reports, files, { shards: 2, root, base }) as string | null;
const swap = (at: number, value: unknown) => { const reports = good(); reports.set(at, value); return reports; };

describe("pipeline-speed A: the shards' join", () => {
  test("every shard's report stands and every file ran once: the join passes", () => {
    expect(problem(good())).toBeNull();
  });

  test.each([
    // Codex's reproduction: reports whose every test was skipped passed with zero tests executed.
    ["every shard skipped everything", () => new Map<number, unknown>([[1, report([file("src/a.test.ts", 0, 2), file("src/native.test.ts", 0, 1)])], [2, report([file("src/b.test.ts", 0, 1), file("test/attacks/d.test.ts", 0, 1)])]]), /never skips one|executed no tests/],
    ["a shard executed nothing (its files' skips allowed)", () => swap(1, report([file("src/native.test.ts", 0, 3)])), /executed no tests/],
    ["a report with every count zero and no results", () => swap(2, { success: true, numFailedTests: 0, numFailedTestSuites: 0, numTotalTests: 0, numPassedTests: 0, numPendingTests: 0, numTodoTests: 0, testResults: [] }), /executed no tests/],
    ["a file with no tests", () => swap(2, report([file("src/b.test.ts", 0, 0, "passed"), file("test/attacks/d.test.ts")])), /reports no tests/],
    ["a total that isn't its results", () => swap(2, report([file("src/b.test.ts"), file("test/attacks/d.test.ts")], { numTotalTests: 40 })), /says 40 tests/],
    ["a passed count that isn't its results", () => swap(2, report([file("src/b.test.ts"), file("test/attacks/d.test.ts")], { numPassedTests: 9 })), /says 9 passed/],
    ["a skipped count that isn't its results", () => swap(1, report([file("src/a.test.ts"), file("src/native.test.ts", 1, 3)], { numPendingTests: 0 })), /says 0 skipped/],
    ["a test the base always ran, now skipped", () => swap(2, report([file("src/b.test.ts"), file("test/attacks/d.test.ts", 1, 1)])), /d\.test\.ts skipped 1 test, and the base revision's copy of it never skips one/],
    ["a failed test", () => swap(2, report([file("src/b.test.ts"), { ...file("test/attacks/d.test.ts"), assertionResults: [{ status: "failed" }] }])), /has a test that failed/],
    ["a report that didn't pass", () => swap(2, { ...report([file("src/b.test.ts"), file("test/attacks/d.test.ts")]), success: false }), /didn't pass/],
    ["a failed suite", () => swap(2, { ...report([file("src/b.test.ts"), file("test/attacks/d.test.ts")]), numFailedTestSuites: 1 }), /numFailedTestSuites 1/],
    ["a file outside the checkout", () => swap(2, report([file("src/b.test.ts"), { ...file("x"), name: "/elsewhere/test/attacks/d.test.ts" }])), /outside the checkout/],
    ["a relative file name", () => swap(2, report([file("src/b.test.ts"), { ...file("x"), name: "test/attacks/d.test.ts" }])), /outside the checkout/],
    ["an unreadable report", () => swap(2, null), /can't be read/],
    ["not a Vitest report", () => swap(2, { files: [] }), /isn't a Vitest JSON report/],
    ["a shard gave no report", () => { const reports = good(); reports.delete(2); return reports; }, /shard 2\/2 gave no report/],
    ["a report for a shard that doesn't exist", () => { const reports = good(); reports.set(3, report([file("src/b.test.ts")])); return reports; }, /shard 3 of 2/],
    ["a file ran in no shard", () => swap(1, report([file("src/a.test.ts")])), /src\/native\.test\.ts/],
    ["a file ran in two shards", () => swap(2, report([file("src/b.test.ts"), file("test/attacks/d.test.ts"), file("src/a.test.ts")])), /ran in shards 1 and 2/],
    ["a shard ran a file the policy doesn't find", () => swap(2, report([file("src/b.test.ts"), file("test/attacks/d.test.ts"), file("src/elsewhere.test.ts")])), /doesn't find here/],
  ])("%s: the join fails", (_, make, why) => {
    expect(problem(make())).toMatch(why);
  });

  test("a new file may skip (it takes no coverage the base had); a file the base may skip may skip", () => {
    expect(readReport(report([file("src/b.test.ts", 1, 2)]), { root, base })).toMatchObject({ ok: true, tests: { passed: 1, notRun: 2 } });
    expect(readReport(report([file("src/native.test.ts", 1, 5)]), { root, base })).toMatchObject({ ok: true });
  });

  test("test-matrix: on a lane that requires its platform's native attacks, a native probe gives a file no permission to skip", () => {
    // The base's attack files: one that skips only through Seatbelt, one through the OS fence or Codex's sandbox, one
    // through the OS fence and a plain platform skip.
    write(base, "test/attacks/seatbelt.test.ts", "test('native', ctx => { needs(ctx, seatbelt()); });\n");
    write(base, "test/attacks/fence.test.ts", "test('native', ctx => { needs( ctx , osFence() ); });\ntest('codex', ctx => { needs(ctx, codexSandbox()); });\n");
    write(base, "test/attacks/linux.test.ts", "test('native', ctx => { ctx.skip(process.platform !== 'linux', 'not Linux'); needs(ctx, osFence()); });\n");
    const read = (name: string, native?: string) => readReport(report([file(name, 1, 1)]), { root, base, native });
    // Without a native policy every one of them may skip, as before.
    for (const name of ["test/attacks/seatbelt.test.ts", "test/attacks/fence.test.ts", "test/attacks/linux.test.ts"]) expect(read(name), name).toMatchObject({ ok: true });
    // On macOS: Seatbelt is required; a file that can still skip some other way (Codex, a platform skip) may.
    expect(read("test/attacks/seatbelt.test.ts", "darwin")).toMatchObject({ ok: false, problem: expect.stringContaining("but through a native darwin probe, which this lane requires") });
    expect(read("test/attacks/fence.test.ts", "darwin")).toMatchObject({ ok: true });
    expect(read("test/attacks/linux.test.ts", "darwin")).toMatchObject({ ok: true });
    // On Linux: Seatbelt there is "not macOS", a skip it may take; the OS fence is required.
    expect(read("test/attacks/seatbelt.test.ts", "linux")).toMatchObject({ ok: true });
    write(base, "test/attacks/bwrap.test.ts", "test('native', ctx => { needs(ctx, osFence()); });\n");
    expect(read("test/attacks/bwrap.test.ts", "linux")).toMatchObject({ ok: false, problem: expect.stringContaining("native linux probe") });
    // An unknown platform is no policy at all: the join fails.
    expect(shardsProblem(good(), listed, { shards: 2, root, base, native: "win32" })).toMatch(/no native policy for win32/);
    expect(shardsProblem(good(), listed, { shards: 2, root, base, native: "darwin" })).toBeNull();
  });

  test("no shard count or an empty inventory: the join fails", () => {
    expect(shardsProblem(good(), listed, { shards: 0, root, base })).toMatch(/no shard count/);
    expect(problem(good(), [])).toMatch(/finds no test files/);
  });

  test("the include policy is vitest.config.ts's, and finds exactly its files without following a symlinked folder", () => {
    const config = readFileSync(join(import.meta.dirname, "..", "vitest.config.ts"), "utf8");
    // The whole suite, unless TOOLROLL_TEST_LANE names a lane: then exactly that lane's files.
    expect(JSON.parse(/include:[^\[]*\?\s*(\[[^\]]*\])/.exec(config)![1]!.replace(/'/g, "\""))).toEqual(INCLUDE);
    expect(config).toContain(`: laneFiles(import.meta.dirname, lane),`);
    const tree = join(scratch, "tree");
    for (const one of ["src/a.test.ts", "src/deep/b.test.ts", "src/helper.ts", "test/attacks/c.test.ts", "test/other.test.ts", "src/node_modules/x.test.ts"]) write(tree, one, "");
    mkdirSync(join(scratch, "outside"), { recursive: true });
    write(scratch, "outside/e.test.ts", "");
    symlinkSync(join(scratch, "outside"), join(tree, "src", "linked"));
    expect(inventory(tree)).toEqual(["src/a.test.ts", "src/deep/b.test.ts", "test/attacks/c.test.ts"]);
  });

  test("the reports' folder holds exactly one report per shard folder of this Node version, nothing else", () => {
    const folder = (name: string) => { const at = join(scratch, name); mkdirSync(at, { recursive: true }); return at; };
    const ok = folder("shards-ok");
    write(ok, "shard-22-1/shard-report.json", JSON.stringify(report([file("src/a.test.ts")])));
    write(ok, "shard-22-2/shard-report.json", "not json");
    const read = reportsIn(ok, "22");
    expect([...read.keys()].sort()).toEqual([1, 2]);
    expect(read.get(2)).toBeNull();
    const other = folder("shards-other");
    write(other, "shard-24-1/shard-report.json", "{}");
    expect(() => reportsIn(other, "22")).toThrow(/unexpected shard-24-1/);
    const extra = folder("shards-extra");
    write(extra, "shard-22-1/shard-report.json", "{}");
    write(extra, "shard-22-1/summary.json", "{}");
    expect(() => reportsIn(extra, "22")).toThrow(/exactly one shard-report.json/);
    const loose = folder("shards-loose");
    write(loose, "forged.json", "{}");
    expect(() => reportsIn(loose, "22")).toThrow(/unexpected forged\.json/);
  });
});

const REPO = join(import.meta.dirname, "..");

describe("ci-speed item 3: the macOS lane", () => {
  test("a file is in by its area, by the smoke list, or because its text names something platform-specific; nothing else", () => {
    const tree = join(scratch, "lane");
    write(tree, "src/agent-fence-x.test.ts", "test('x', () => {});\n");
    write(tree, "src/plain.test.ts", "test('plain', () => {});\n");
    write(tree, "src/branches.test.ts", "test.skipIf(process.platform === 'linux')('mac', () => {});\n");
    write(tree, "src/launch.test.ts", "// writes a LaunchAgent plist\n");
    write(tree, "src/store.test.ts", "test('store', () => {});\n");
    write(tree, "test/attacks/fence-y.test.ts", "test('y', () => {});\n");
    write(tree, "test/attacks/release-z.test.ts", "test('z', () => {});\n");
    write(tree, "test/attacks/release-native.test.ts", "test('n', ctx => { needs(ctx, seatbelt()); });\n");
    expect(laneFiles(tree, "macos")).toEqual(["src/agent-fence-x.test.ts", "src/branches.test.ts", "src/launch.test.ts", "src/store.test.ts", "test/attacks/fence-y.test.ts", "test/attacks/release-native.test.ts"]);
    expect(() => laneFiles(tree, "windows")).toThrow(/no lane windows/);
  });

  test("in this checkout: every macOS native attack, the fences, launchd, the desktop app, linking, installing and git views are in the lane", () => {
    const lane = laneFiles(REPO, "macos");
    const all = inventory(REPO);
    // A test the macOS shards must run (TOOLROLL_REQUIRE_NATIVE=darwin) can never fall out: every file that probes
    // Seatbelt or the OS fence is in, by its text, whatever its name.
    const native = all.filter(file => new RegExp(NATIVE_PROBES.darwin.source).test(readFileSync(join(REPO, file), "utf8")));
    expect(native.length).toBeGreaterThan(5);
    expect(native.filter(file => !lane.includes(file))).toEqual([]);
    for (const file of ["src/agent-fence.slow.test.ts", "src/sandbox-launch.test.ts", "src/daemon.test.ts", "src/desktop-update.slow.test.ts", "src/link.test.ts", "src/install-method.test.ts",
      "src/up.slow.test.ts", "src/worktree.slow.test.ts", "src/teardown-git.test.ts", "src/toolroll-update.slow.test.ts", "test/attacks/fence-apple-events.test.ts", "test/attacks/fence-keychain.test.ts",
      "test/attacks/checkout-git-view-binding.test.ts", "test/attacks/release-carry.test.ts"]) expect(lane, file).toContain(file);
    // Every listed path and smoke file still names something here: a renamed file can't leave a dead entry behind.
    for (const pattern of LANES.macos.paths) expect(all.some(file => pattern.test(file)), String(pattern)).toBe(true);
    for (const file of LANES.macos.smoke) expect(all, file).toContain(file);
    // It is a lane, not the suite: the release policy's own attacks run on Linux only.
    expect(lane).not.toContain("test/attacks/auto-approve-green.test.ts");
    expect(lane.length).toBeLessThan(all.length / 2);
  });

  test("the join judges the lane: the shards must run exactly its files, once", () => {
    const tree = join(scratch, "lane-join");
    for (const one of ["src/mac.test.ts", "src/plain.test.ts"]) write(tree, one, one.includes("mac") ? "test('m', () => { if (process.platform === 'darwin') {} });\n" : "test('p', () => {});\n");
    const files = laneFiles(tree, "macos");
    expect(files).toEqual(["src/mac.test.ts"]);
    const at = (name: string) => ({ name: join(tree, name), status: "passed", assertionResults: [{ status: "passed" }] });
    const one = (names: string[]) => new Map<number, unknown>([[1, report(names.map(at))]]);
    expect(shardsProblem(one(["src/mac.test.ts"]), files, { shards: 1, root: tree, base: tree })).toBeNull();
    expect(shardsProblem(one([]), files, { shards: 1, root: tree, base: tree })).toMatch(/executed no tests|ran in no shard/);
    expect(shardsProblem(one(["src/mac.test.ts", "src/plain.test.ts"]), files, { shards: 1, root: tree, base: tree })).toMatch(/include policy doesn't find/);
    // The command line refuses a lane it doesn't know.
    const cli = spawnSync(process.execPath, [join(REPO, "scripts/ci-shards.mjs"), "verify", scratch, "--root", tree, "--base", tree, "--sha", "a".repeat(40), "--node", "24", "--shards", "1", "--lane", "windows"], { encoding: "utf8" });
    expect(cli.status).toBe(1);
    expect(cli.stderr).toMatch(/--lane takes all or macos/);
  });
});

describe("ci-speed item 1: timing-balanced shards", () => {
  const timings = { linux: { "a.test.ts": 100, "b.test.ts": 60, "c.test.ts": 50, "d.test.ts": 40, "e.test.ts": 10 }, darwin: { "a.test.ts": 300 } };
  test("every file goes to exactly one shard, longest first, and the same inputs give the same plan", () => {
    const files = ["e.test.ts", "d.test.ts", "c.test.ts", "b.test.ts", "a.test.ts", "new.test.ts"];
    const { plan } = planShards(files, timings, 2, { workers: 1 });
    expect([...plan.keys()].sort()).toEqual([...files].sort());
    expect(new Set(plan.values())).toEqual(new Set([0, 1]));
    // Balanced on time: a (100) alone against b+c (110), then d, e and the untimed file fill the lighter shard.
    expect(plan.get("a.test.ts")).not.toBe(plan.get("b.test.ts"));
    expect(planShards([...files].reverse(), timings, 2, { workers: 1 }).plan).toEqual(plan);
    expect(() => planShards(files, timings, 0)).toThrow(/no shard count/);
  });

  test("a file timed on one platform only weighs the same on the other; one never timed weighs a typical file", () => {
    const linux = planShards(["a.test.ts", "b.test.ts"], timings, 2, { platform: "linux" }).shards;
    const darwin = planShards(["a.test.ts", "b.test.ts"], timings, 2, { platform: "darwin" }).shards;
    expect(Math.max(...linux.map(one => one.longest))).toBe(100);
    expect(Math.max(...darwin.map(one => one.longest))).toBe(300);
    expect(planShards(["z.test.ts"], timings, 1).shards[0]!.total).toBeGreaterThan(0);
  });

  test("the committed timings cover this checkout's suite", () => {
    const committed = JSON.parse(readFileSync(join(REPO, "test", "timings.json"), "utf8")) as { linux: Record<string, number> };
    const all = inventory(REPO);
    // New files plan as typical ones until the next refresh; most of the suite must be timed.
    expect(all.filter(file => committed.linux[file] !== undefined).length).toBeGreaterThan(all.length * 0.9);
  });
});

describe("Codex review round 1, P1: what Linux skips, the macOS lane runs", () => {
  test("a capability probe, a conditional skip or needs() puts a file in the lane, whatever its name", () => {
    const tree = join(scratch, "lane-probes");
    write(tree, "src/a.test.ts", "describe.skipIf(!macosFenceAvailable())('fenced', () => {});\n");
    write(tree, "src/b.test.ts", "const FENCED = macosFenceAvailable() || linuxFenceAvailable();\nif (FENCED) test('x', () => {});\n");
    write(tree, "src/c.test.ts", "test.runIf(HAS_DOCKER)('mail', () => {});\n");
    write(tree, "src/d.test.ts", "test('n', ctx => { needs(ctx, codexSandbox()); });\n");
    write(tree, "src/e.test.ts", "if (os.platform() === 'darwin') {}\n");
    // A skip spelled inside a fixture's text, unconditional, isn't a reason: such a file stays on Linux.
    write(tree, "src/f.test.ts", "const fixture = \"test.skip('later', () => {});\";\ntest('f', () => {});\n");
    expect(laneFiles(tree, "macos")).toEqual(["src/a.test.ts", "src/b.test.ts", "src/c.test.ts", "src/d.test.ts", "src/e.test.ts"]);
  });

  test("in this checkout: the fenced suites Codex found outside the lane are in it", () => {
    const lane = laneFiles(REPO, "macos");
    for (const file of ["src/console-instance.slow.test.ts", "src/acp-check.slow.test.ts", "src/eval-oracle.test.ts", "src/flow-code.test.ts"]) expect(lane, file).toContain(file);
    // Every file whose text can skip or narrow by a capability is in, so the join's report check below never has to catch one.
    const all = inventory(REPO);
    const probed = all.filter(file => LANES.macos.probes.test(readFileSync(join(REPO, file), "utf8")));
    expect(probed.filter(file => !lane.includes(file))).toEqual([]);
  });

  test("the macOS join fails when a file Linux skipped part of ran in no macOS shard, and when a Linux report is missing", () => {
    const tree = join(scratch, "linux-skips");
    const at = (name: string, statuses: string[]) => ({ name: join(tree, name), status: statuses.includes("passed") ? "passed" : "skipped", assertionResults: statuses.map(status => ({ status })) });
    const linux = new Map<number, unknown>([
      [1, report([at("src/fenced.test.ts", ["skipped", "skipped"]), at("src/plain.test.ts", ["passed"])])],
      [2, report([at("src/partly.test.ts", ["passed", "skipped"])])],
    ]);
    expect(linuxSkipsProblem(linux, new Set(["src/fenced.test.ts", "src/partly.test.ts"]), { shards: 2, root: tree })).toBeNull();
    // Wholly skipped on Linux and not run on the Mac: Codex's console-instance case.
    expect(linuxSkipsProblem(linux, new Set(["src/partly.test.ts"]), { shards: 2, root: tree })).toMatch(/src\/fenced\.test\.ts.*must run them/);
    // Partly skipped counts the same.
    expect(linuxSkipsProblem(linux, new Set(["src/fenced.test.ts"]), { shards: 2, root: tree })).toMatch(/src\/partly\.test\.ts/);
    // Fail closed: a Linux shard without a readable report.
    expect(linuxSkipsProblem(new Map([[1, linux.get(1)]]), new Set(["src/fenced.test.ts", "src/partly.test.ts"]), { shards: 2, root: tree })).toMatch(/Linux shard 2\/2 gave no readable report/);
    expect(linuxSkipsProblem(new Map([[1, null], [2, linux.get(2)]]), new Set(), { shards: 2, root: tree })).toMatch(/Linux shard 1\/2/);
    expect(linuxSkipsProblem(linux, new Set(), { shards: 0, root: tree })).toMatch(/no Linux shard count/);
  });

  test("the command line refuses a lane without the Linux reports, and fails a lane that misses a Linux skip", () => {
    const tree = join(scratch, "linux-skips-cli");
    write(tree, "src/mac.test.ts", "test('m', () => { if (process.platform === 'darwin') {} });\n");
    write(tree, "src/plain.test.ts", "test('p', () => {});\n");
    const mac = join(scratch, "mac-reports"), lin = join(scratch, "linux-reports");
    write(mac, "shard-24-1/shard-report.json", JSON.stringify(report([{ name: join(tree, "src/mac.test.ts"), status: "passed", assertionResults: [{ status: "passed" }] }])));
    const cli = (extra: string[]) => spawnSync(process.execPath, [join(REPO, "scripts/ci-shards.mjs"), "verify", mac, "--root", tree, "--base", tree, "--sha", "a".repeat(40), "--node", "24", "--shards", "1", "--lane", "macos", ...extra], { encoding: "utf8" });
    expect(cli([]).stderr).toMatch(/a lane needs --linux-reports/);
    // Linux skipped part of plain.test.ts, which the lane doesn't hold: the join fails.
    write(lin, "shard-24-1/shard-report.json", JSON.stringify(report([{ name: join(tree, "src/plain.test.ts"), status: "passed", assertionResults: [{ status: "passed" }, { status: "skipped" }] }])));
    const failed = cli(["--linux-reports", lin, "--linux-shards", "1"]);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toMatch(/src\/plain\.test\.ts.*must run them/);
    write(lin, "shard-24-1/shard-report.json", JSON.stringify(report([{ name: join(tree, "src/plain.test.ts"), status: "passed", assertionResults: [{ status: "passed" }] }])));
    const passed = cli(["--linux-reports", lin, "--linux-shards", "1"]);
    expect(passed.status, passed.stderr).toBe(0);
  });
});
