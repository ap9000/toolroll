/**
 * The tamper scan's reading of changed code (docs/plans/trusted-release-reports.md, H4). Each row is an edit a count
 * would have missed, or a form it must keep seeing. It is a heuristic: nothing here decides an approval.
 */
import { describe, expect, test } from "vitest";
import { runnerExpressions, tamperFindings } from "./tamper-scan.js";
import { testImportProblem } from "./test-infra.js";

describe("what a count would miss", () => {
  test.each([
    ["an edited argument", "process.exit(1);\n", "process.exit(0);\n", ["process.exit(0)"]],
    ["an edited assignment", "process.exitCode = 1;\n", "process.exitCode = 0;\n", ["process.exitCode"]],
    ["a new binding", "const a = 1;\n", "const p = process;\n", ["p = process"]],
    ["a computed reach", "const a = 1;\n", "process[name]();\n", ["process[name]"]],
  ])("%s shows", (_, base, candidate, words) => {
    expect(tamperFindings("src/a.ts", base, candidate).join("\n")).toContain(words[0]);
  });
  test("moving an expression, or leaving it, shows nothing", () => {
    expect(tamperFindings("src/a.ts", "function a() { process.exit(1); }\n", "function b() {\n  process.exit(1);\n}\n")).toEqual([]);
  });
  test("a second copy of the same expression shows once", () => {
    expect(tamperFindings("src/a.ts", "process.exit(1);\n", "process.exit(1);\nprocess.exit(1);\n")).toEqual(["process.exit(1)"]);
  });
  test("a new file is compared with nothing", () => { expect(tamperFindings("src/a.ts", null, "process.exit(0);\n")).toEqual(["process.exit(0)"]); });
});

test.each([
  ["vitest internals", 'import x from "@vitest/runner";\n'],
  ["code from a string", "eval(text);\n"],
  ["a Function constructor", "new Function(text)();\n"],
  ["a replaced global", "globalThis.expect = fake;\n"],
  ["a prototype rewritten", "Array.prototype.map = fake;\n"],
  ["a defined property", 'Object.defineProperty(expect, "x", {});\n'],
  ["the module cache", "delete require.cache[x];\n"],
  ["a harness path", 'const a = "/proc/1/environ";\n'],
])("%s is seen", (_, text) => { expect(runnerExpressions("src/a.ts", text)).not.toEqual([]); });

test("product code reading a test's environment is seen; a test doing so isn't", () => {
  expect(runnerExpressions("src/a.ts", "if (process.env.VITEST) go();\n")).toEqual(["process.env.VITEST"]);
  expect(runnerExpressions("src/a.ts", 'if (process.env["CI"]) go();\n')).toEqual(['process.env["CI"]']);
  expect(runnerExpressions("src/a.test.ts", "if (process.env.VITEST) go();\n")).toEqual([]);
});

describe("a new test reaching into another", () => {
  test.each([
    ["a static import", 'import "./other.test.js";\n'],
    ["a named import", 'import { x } from "./other.test.ts";\n'],
    ["an extensionless import", 'import "../src/other.test";\n'],
    ["a dynamic import", 'await import("./other.test.js");\n'],
    ["a require", 'require("./other.test.js");\n'],
    ["a query on the path", 'import "./other.test.js?x";\n'],
    ["vi.importActual", 'await vi.importActual("./other.test.js");\n'],
    ["a path computed at run time", "await import(name);\n"],
  ])("%s refuses", (_, text) => { expect(testImportProblem("src/new.test.ts", text)).not.toBeNull(); });
  test.each([
    ["the code it tests", 'import { a } from "./a.js";\n'],
    ["a helper with a test-like name", 'import { b } from "./latest.js";\n'],
    ["a package", 'import { test } from "vitest";\n'],
  ])("%s stands", (_, text) => { expect(testImportProblem("src/new.test.ts", text)).toBeNull(); });
});
