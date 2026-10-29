/**
 * The CI unit suite's shards (scripts/ci-shards.mjs, docs/plans/pipeline-speed.md part A): a required "node N ·
 * ubuntu-latest" check passes only when every shard passed on the tested commit and together they ran every listed
 * test file exactly once. Each way a shard set can fall short is one row.
 */
import { describe, expect, test } from "vitest";
import { shardsProblem, summarize } from "../scripts/ci-shards.mjs";

const sha = "a".repeat(40);
type Summary = { version: number; sha: string; node: string; shard: number; of: number; files: string[]; tests: { total: number; passed: number; failed: number; skipped: number } };
const listed = ["src/a.test.ts", "src/b.test.ts", "src/c.test.ts", "test/attacks/d.test.ts"];
const shard = (at: number, files: string[], extra: Partial<Summary> = {}): Summary =>
  ({ version: 1, sha, node: "22", shard: at, of: 2, files, tests: { total: files.length, passed: files.length, failed: 0, skipped: 0 }, ...extra });
const good = () => [shard(1, ["src/a.test.ts", "src/c.test.ts"]), shard(2, ["src/b.test.ts", "test/attacks/d.test.ts"])];
const problem = (summaries: unknown[], files = listed) => shardsProblem(summaries, files, { sha, node: "22", shards: 2 }) as string | null;

describe("pipeline-speed A: the shards' join", () => {
  test("every shard passed on the commit and every listed file ran once: the join passes", () => {
    expect(problem(good())).toBeNull();
  });

  test.each([
    ["a shard gave no summary", () => good().slice(0, 1), /shard 2\/2 gave no summary/],
    ["a summary can't be read", () => [...good(), null], /can't be read/],
    ["a shard reported twice", () => [...good(), good()[0]], /reported twice/],
    ["a shard tested another commit", () => [good()[0], { ...good()[1], sha: "b".repeat(40) }], /tested bbbbbbb/],
    ["a shard of another Node version", () => [good()[0], { ...good()[1], node: "24" }], /node 24/],
    ["a shard of another split", () => [good()[0], { ...good()[1], of: 3 }], /one of 3/],
    ["a shard with a failed test", () => [good()[0], { ...good()[1], tests: { total: 2, passed: 1, failed: 1, skipped: 0 } }], /didn't pass/],
    ["a file ran in no shard", () => [shard(1, ["src/a.test.ts"]), good()[1]], /src\/c\.test\.ts/],
    ["a file ran in two shards", () => [good()[0], shard(2, ["src/a.test.ts", "src/b.test.ts", "test/attacks/d.test.ts"])], /ran in shards 1 and 2/],
    ["a shard ran a file Vitest doesn't list", () => [good()[0], shard(2, ["src/b.test.ts", "test/attacks/d.test.ts", "src/elsewhere.test.ts"])], /doesn't list/],
    ["an unknown summary version", () => [good()[0], { ...good()[1], version: 2 }], /unknown version/],
  ])("%s: the join fails", (_, make, why) => {
    expect(problem(make())).toMatch(why);
  });

  test("no tested commit, no shard count or no listed files: the join fails", () => {
    expect(shardsProblem(good(), listed, { sha: "HEAD", node: "22", shards: 2 })).toMatch(/no tested commit/);
    expect(shardsProblem(good(), listed, { sha, node: "22", shards: 0 })).toMatch(/no shard count/);
    expect(problem(good(), [])).toMatch(/listed no test files/);
  });

  test("a shard's summary is written only from a passing Vitest report", () => {
    const report = { success: true, numFailedTests: 0, numFailedTestSuites: 0, numTotalTests: 3, numPassedTests: 2, numPendingTests: 1, numTodoTests: 0,
      testResults: [{ name: "src/b.test.ts", status: "passed" }, { name: "src/a.test.ts", status: "passed" }] };
    expect(summarize(report, { sha, node: "22", shard: 1, of: 2 })).toEqual({ version: 1, sha, node: "22", shard: 1, of: 2, files: ["src/a.test.ts", "src/b.test.ts"], tests: { total: 3, passed: 2, failed: 0, skipped: 1 } });
    for (const bad of [
      { ...report, success: false }, { ...report, numFailedTests: 1 }, { ...report, numFailedTestSuites: 1 }, { ...report, testResults: [] },
      { ...report, testResults: [{ name: "src/a.test.ts", status: "failed" }] }, { ...report, numTotalTests: 0 }, null,
    ]) expect(() => summarize(bad, { sha, node: "22", shard: 1, of: 2 })).toThrow();
    expect(() => summarize(report, { sha: "", node: "22", shard: 1, of: 2 })).toThrow(/no tested commit/);
    expect(() => summarize(report, { sha, node: "22", shard: 3, of: 2 })).toThrow(/no shard index/);
  });
});
