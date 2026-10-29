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
import { INCLUDE, inventory, readReport, reportsIn, shardsProblem } from "../scripts/ci-shards.mjs";

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

  test("no shard count or an empty inventory: the join fails", () => {
    expect(shardsProblem(good(), listed, { shards: 0, root, base })).toMatch(/no shard count/);
    expect(problem(good(), [])).toMatch(/finds no test files/);
  });

  test("the include policy is vitest.config.ts's, and finds exactly its files without following a symlinked folder", () => {
    const config = readFileSync(join(import.meta.dirname, "..", "vitest.config.ts"), "utf8");
    expect(JSON.parse(/include:\s*(\[[^\]]*\])/.exec(config)![1]!.replace(/'/g, "\""))).toEqual(INCLUDE);
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
