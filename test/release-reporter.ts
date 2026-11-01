/**
 * The release check's unit results (docs/plans/release-once.md, "How results travel"): one JSON line per test and per
 * file, written by the Vitest MAIN process to fd 3 — a pipe only the release check's orchestrator holds. Workers never
 * inherit it (Vitest forks them with their own stdio), nothing is written to disk, and a test that prints something
 * that looks like a result line only prints to the log.
 *
 * It writes only when the orchestrator says fd 3 is its pipe (TOOLROLL_CHECK_RESULTS_FD=3) and fd 3 is a pipe, so a
 * person's own `vitest run --reporter=./test/release-reporter.ts` writes nothing anywhere.
 *
 * Lines:
 *   {"kind":"unit-case","file":"src/a.test.ts","name":"suite > test","state":"passed"|"failed"|"skipped","flaky":false}
 *   {"kind":"unit-file","file":"src/a.test.ts","state":"passed"|"failed"|"skipped","passed":3,"failed":0,"skipped":0,"flaky":false}
 *   {"kind":"unit-end","reason":"passed"|"failed"|"interrupted","errors":0}
 */
import { fstatSync, writeSync } from "node:fs";
import { relative, sep } from "node:path";
import type { Reporter, TestCase, TestModule } from "vitest/node";

const enabled = (() => {
  if (process.env["TOOLROLL_CHECK_RESULTS_FD"] !== "3") return false;
  try { const fd = fstatSync(3); return fd.isFIFO() || fd.isSocket(); } catch { return false; }
})();

const write = (line: Record<string, unknown>): void => {
  if (!enabled) return;
  try { writeSync(3, `${JSON.stringify(line)}\n`); } catch { /* the orchestrator went away: its own end decides */ }
};

const fileOf = (moduleId: string): string => relative(process.cwd(), moduleId).split(sep).join("/");

const stateOf = (state: string): "passed" | "failed" | "skipped" | null =>
  state === "passed" || state === "failed" || state === "skipped" ? state : null;

export default class ReleaseReporter implements Reporter {
  onTestCaseResult(testCase: TestCase): void {
    const state = stateOf(testCase.result().state);
    if (state === null) return;
    write({ kind: "unit-case", file: fileOf(testCase.module.moduleId), name: testCase.fullName, state, flaky: testCase.diagnostic()?.flaky === true });
  }

  onTestModuleEnd(testModule: TestModule): void {
    const counts = { passed: 0, failed: 0, skipped: 0 };
    let flaky = false;
    for (const test of testModule.children.allTests()) {
      const state = stateOf(test.result().state);
      if (state !== null) counts[state]++;
      if (test.diagnostic()?.flaky === true) flaky = true;
    }
    // A file that failed to load (an import error, a throw at the top) has no tests and still failed.
    const moduleState = testModule.state();
    const state = moduleState === "failed" || counts.failed > 0 || (testModule.errors?.() ?? []).length > 0 ? "failed"
      : moduleState === "skipped" || (counts.passed === 0 && counts.skipped > 0) ? "skipped"
      : moduleState === "passed" ? "passed" : "failed";
    write({ kind: "unit-file", file: fileOf(testModule.moduleId), state, ...counts, flaky });
  }

  onTestRunEnd(_modules: ReadonlyArray<TestModule>, unhandledErrors: ReadonlyArray<unknown>, reason: string): void {
    write({ kind: "unit-end", reason, errors: unhandledErrors.length });
  }
}
