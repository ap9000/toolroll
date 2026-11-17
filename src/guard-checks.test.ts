/** Advisory guard contracts. Each rule has a violating and a repaired candidate, with fixes in its diagnostic. */
import { describe, expect, test } from "vitest";
import { addedLines, checkFiles, FIXES, lex, LINE_MAX, printedGuards, readGuardInput } from "../scripts/guard-checks.mjs";

type File = { path: string; before: string; after: string; added: Set<number> };
const file = (path: string, after: string, before = ""): File => ({ path, before, after, added: new Set(after.split("\n").map((_, at) => at + 1)) });
const check = (one: File, messages: string[] = [], all = false) => checkFiles({ files: [one], messages, all });
const withTrailer = (path: string) => `Explain the change\n\nGate-change: ${path} — intentional budget tradeoff\nCo-Authored-By: Example <example@example.com>`;
const flaky = "wait on a fact (state, event, file), never a fixed sleep — see AGENTS.md flaky-test rule";
const rustTest = (body: string) => `#[cfg(test)]\nmod tests {\n#[test]\nfn works() {\n${body}\n}\n}`;

const cases = [
  { rule: 1, path: "src/example.ts", bad: "if (false) work();", good: "if (ready) work();", fix: "restore the real condition" },
  { rule: 2, path: "src/example.test.ts", bad: "await sleep(100);", good: "await finished;", fix: flaky },
  { rule: 3, path: "vitest.config.ts", before: "testTimeout: 1000,", bad: "testTimeout: 2000,", good: "testTimeout: 900,", fix: flaky },
  { rule: 4, path: "tui/crates/example/src/lib.rs", bad: rustTest('std::env::set_var("EXAMPLE", "value");'), good: rustTest('run_with_env(&[("EXAMPLE", "value")]);'), fix: "pass the value explicitly or use a per-test env map" },
  { rule: 5, path: "tui/crates/example/src/lib.rs", bad: "let kind = libc::S_IFDIR as u32;", good: "let kind: libc::mode_t = libc::S_IFDIR;", fix: "compare in the platform's own mode_t (u16 on macOS, u32 on Linux)" },
  { rule: 6, path: "test/perf/wire-ceilings.json", before: '{"page":{"bytes":100}}', bad: '{"page":{"bytes":101}}', good: '{"page":{"bytes":99}}', fix: "lower the ceiling or disclose the increase" },
  { rule: 7, path: "src/store.ts", before: "function first() {}\nfunction last() {}", bad: "function first() {}\nfunction added() {}\nfunction last() {}", good: "function first() {}\nfunction last() {}\nfunction added() {}", fix: "append new top-level functions at the END" },
  { rule: 8, path: "scripts/ci-example.mjs", bad: "console.log(candidate);", good: "console.log(printed(verdict));", fix: "existing stop-commands wrapper" },
] as const;

describe("guard rules and root-cause fixes", () => {
  test.each(cases)("rule $rule rejects the violation and accepts its repair", row => {
    const before = "before" in row ? row.before : "";
    const bad = check(file(row.path, row.bad, before));
    const hits = bad.findings.filter((one: { rule: number }) => one.rule === row.rule);
    expect(hits).toHaveLength(1);
    expect(hits[0].message).toContain(row.fix);
    expect(hits[0].message).toContain(FIXES[row.rule]);
    expect(hits[0].severity).toBe(row.rule === 8 ? "warning" : "error");
    expect(bad.ok).toBe(row.rule === 8);
    expect(check(file(row.path, row.good, before)).findings).toEqual([]);
  });

  test.each([
    "if false {}", "if (false) work();", "run() || true", "run() && false", "suite.only('case')",
    "describe.only('case')", "it.only('case')", "test.only.each(cases)", "fit('case')", "fdescribe('case')",
    "dbg!(value)", "todo!()", "debugger;",
  ])("rule 1 catches %s", text => {
    expect(check(file("src/example.ts", text)).findings.some((one: { rule: number }) => one.rule === 1)).toBe(true);
  });

  test.each(["scripts/example.sh", ".github/workflows/example.yml"])("shell exception needs a reason: %s", path => {
    const prefix = path.endsWith(".yml") ? "run: |\n  " : "";
    expect(check(file(path, prefix + "run || true # guard: allow cleanup can find no process")).ok).toBe(true);
    expect(check(file(path, "run || true # guard: allow ")).ok).toBe(false);
    expect(check(file(path, "run || true")).ok).toBe(false);
  });
  test("a shell marker cannot waive a TypeScript short-circuit", () => {
    expect(check(file("src/example.ts", "run() || true // # guard: allow cleanup")).ok).toBe(false);
    expect(check(file("docs/example.md", "debugger;")).ok).toBe(true);
    expect(check(file(".github/workflows/example.yml", "if: value || true # guard: allow not shell")).ok).toBe(false);
  });

  test.each([
    ["src/example.test.ts", "setTimeout(done, 100);"],
    ["src/example.test.ts", "await new Promise(r => setTimeout(r, 100));"],
    ["tui/crates/example/tests/check.rs", "thread::sleep(duration);"],
    ["tui/crates/example/tests/check.rs", "tokio::time::sleep(duration).await;"],
  ])("rule 2 requires a fact or a documented ceiling: %s %s", (path, text) => {
    expect(check(file(path, text)).ok).toBe(false);
    expect(check(file(path, `${text} // guard: bound runner starvation ceiling; finished event wins`)).ok).toBe(true);
    expect(check(file(path, `${text} // guard: bound `)).ok).toBe(false);
    expect(check(file("src/production.ts", text)).ok).toBe(true);
  });

  test.each([
    ["hookTimeout: 10", "hookTimeout: 20"],
    ['"testTimeout": 1e3', '"testTimeout": 2e3'],
    ["hookTimeout: 1.5", "hookTimeout: 2.5"],
    ["test('case', () => {}, 100)", "test('case', () => {}, 200)"],
    ["it('case', async () => { await event; }, 100)", "it('case', async () => { await event; }, 200)"],
    ["test(\n'case',\n() => { fn(a, b); },\n1_000\n)", "test(\n'case',\n() => { fn(a, b); },\n2_000\n)"],
    ["test('case name', () => {}, 100,)", "test('case name', () => {}, 200,)"],
  ])("rule 3 compares matching timeouts across changed lines", (before, after) => {
    expect(check(file("src/example.test.ts", after, before)).findings.some((one: { rule: number }) => one.rule === 3)).toBe(true);
    expect(check(file("src/example.test.ts", before, after)).ok).toBe(true);
  });
  test("rule 3 does not pair an unrelated removed test with a new test", () => {
    expect(check(file("src/example.test.ts", "test('new', () => {}, 200)", "test('old', () => {}, 100)")).ok).toBe(true);
    expect(check(file("src/example.test.ts", 'test("case", () => {}, 200)', "test('case', () => {}, 100)")).ok).toBe(false);
  });

  test.each(["set_var", "remove_var"])("rule 4 distinguishes Rust test environment writes: %s", operation => {
    const text = `std::env::${operation}("EXAMPLE");`;
    expect(check(file("tui/crates/example/tests/env.rs", text)).ok).toBe(false);
    expect(check(file("tui/crates/example/src/lib.rs", `#[tokio::test]\nasync fn check() { ${text} }`)).ok).toBe(false);
    expect(check(file("tui/crates/example/src/lib.rs", `fn production() { ${text} }`)).ok).toBe(true);
  });
  test.each(["u32::from(libc::S_IFDIR)", "(libc::S_IFMT) as u32", "libc::S_IRUSR as u32"])("rule 5 preserves platform mode constants: %s", text => {
    expect(check(file("tui/crates/example/src/lib.rs", text)).ok).toBe(false);
  });

  test.each(["test/perf/thread-wire-ceilings.json", "test/perf/wire-ceilings.json", "test/click-path-ceilings.json"])("rule 6 shares trailer parsing and compares nested numeric leaves: %s", path => {
    const changed = file(path, '{"rows":[{"bytes":11}],"count":2}', '{"rows":[{"bytes":10}],"count":3}');
    expect(check(changed).ok).toBe(false);
    expect(check(changed, [withTrailer(path)]).ok).toBe(true);
    expect(check(changed, [withTrailer("test/**")]).ok).toBe(true);
    expect(check(changed, [`Subject\n\nGate-change: ${path} — reason\n\nNot a trailer.`]).ok).toBe(false);
    expect(check(changed, [withTrailer("test/other.json")]).ok).toBe(false);
    expect(check(file(path, '{"existing":1,"new":10}', '{"existing":1}')).ok).toBe(true);
  });

  test.each(["src/store.ts", "src/operate.ts", "src/server/tasks.ts"])("rule 7 appends declarations and function bindings, without counting nested helpers: %s", path => {
    const before = "export async function first() {}\nfunction last() {}";
    expect(check(file(path, "export const added = () => {};\n" + before, before)).ok).toBe(false);
    expect(check(file(path, before + "\nexport const added = async () => {};", before)).ok).toBe(true);
    expect(check(file(path, "export async function first() { function nested() {} }\nfunction last() {}", before)).ok).toBe(true);
    expect(check(file(path, "export async function first() {}\n// function fake() {}\nfunction last() {}", before)).ok).toBe(true);
  });
  test("rule 8 accepts literal output and wrapper calls; warns on dynamic multiline output", () => {
    expect(check(file("scripts/ci-example.mjs", 'console.log("fixed words");')).findings).toEqual([]);
    expect(check(file("scripts/gate-changes.mjs", "console.log(\ncandidate\n);")).findings[0].severity).toBe("warning");
    expect(check(file("scripts/ordinary.mjs", "console.log(candidate);")).findings).toEqual([]);
    expect(check(file("scripts/ci-example.mjs", "echo(candidate);")).findings[0].severity).toBe("warning");
    expect(check(file("scripts/ci-example.mjs", 'run(`echo ${candidate}`);')).findings[0].severity).toBe("warning");
    expect(check(file("scripts/ci-example.mjs", 'console.log(printed({ text: "echo $VALUE" }));')).findings).toEqual([]);
  });
});

describe("diff, bounded matching, and trusted rule loading", () => {
  test("only added source lines are judged, including lines beginning with ++", () => {
    const added = addedLines("diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -2,0 +3,2 @@\n+debugger;\n+++count;\n");
    expect([...added]).toEqual([3, 4]);
    const one = file("src/example.ts", "debugger;\nwork();\ndebugger;");
    one.added = new Set([2]);
    expect(check(one).findings).toEqual([]);
    expect(checkFiles({ files: [one], all: true }).findings).toHaveLength(2);
  });
  test("a multiline violation is caught when only its changed operand is added", () => {
    const one = file("src/example.ts", "if (\nfalse\n) work();");
    one.added = new Set([2]);
    expect(check(one).findings[0]).toMatchObject({ rule: 1, line: 2 });
    const output = file("scripts/ci-example.mjs", "console.log(\ncandidate\n);");
    output.added = new Set([2]);
    expect(check(output).findings[0]).toMatchObject({ rule: 8, line: 2 });
  });

  test.each(cases)("--all reports rule $rule without failing", row => {
    const before = "before" in row ? row.before : "";
    const result = check(file(row.path, row.bad, before), [], true);
    expect(result.ok).toBe(true);
    expect(result.findings.some((one: { rule: number; severity: string }) => one.rule === row.rule && one.severity === "report")).toBe(true);
  });

  test("literal examples, comments and regex patterns are not executable violations", () => {
    const text = 'const example = "debugger; sleep(1);";\n// if false\n/* dbg!(value) */\nconst pattern = /["\'{}]/;\nconst other = \'todo!()\';';
    expect(check(file("src/example.test.ts", text)).findings).toEqual([]);
    expect(check(file("tui/crates/example/src/lib.rs", 'let text = r#"a "quote" todo!()"#;')).findings).toEqual([]);
  });
  test("template interpolations contain executable code, including nested templates", () => {
    expect(check(file("src/example.test.ts", 'const value = `${await sleep(100)}`;')).ok).toBe(false);
    expect(check(file("src/example.test.ts", 'const value = `${`${await sleep(100)}`}`;')).ok).toBe(false);
    expect(check(file("src/example.test.ts", 'const value = `sleep(100)`;')).ok).toBe(true);
  });
  test("cap bytes before matching and refuse oversized added lines rather than hiding their suffix", () => {
    const long = "x".repeat(LINE_MAX) + "debugger;";
    expect(lex(long).tokens).toEqual([]);
    expect(check(file("src/example.ts", long)).findings[0].message).toContain("split this source line to at most 4 KiB");
    expect(check(file("src/example.ts", "é".repeat(LINE_MAX))).ok).toBe(false);
    expect(check(file("src/example.ts", long), [], true).ok).toBe(true);
    expect([...addedLines(`@@ -0,0 +1 @@\n+${long}\n`)]).toEqual([1]);
  });
  test("candidate rule edits are read as data, never loaded; comparisons use the merge base", () => {
    const base = "a".repeat(40), head = "b".repeat(40), merge = "c".repeat(40), calls: string[][] = [];
    const git = (args: string[]) => {
      calls.push(args);
      if (args[0] === "merge-base") return merge + "\n";
      if (args.includes("--name-status")) return "M\0scripts/guard-checks.mjs\0M\0src/example.ts\0";
      if (args.includes("ls-tree")) return "src/example.ts\0";
      if (args[0] === "show") {
        if (args.at(-1) === `${head}:scripts/guard-checks.mjs`) return 'throw new Error("candidate code must never run");';
        return args.at(-1) === `${head}:src/example.ts` ? "debugger;" : "work();";
      }
      if (args.includes("--unified=0")) return "@@ -1 +1 @@\n-work();\n+debugger;\n";
      if (args[0] === "log") return "Subject\0";
      throw new Error(`unexpected git read: ${JSON.stringify(args)}`);
    };
    const input = readGuardInput("/placeholder/checkout", base, head, false, git);
    expect(checkFiles(input).ok).toBe(false);
    expect(calls.some(args => args.includes(`${merge}:src/example.ts`))).toBe(true);
    expect(calls.filter(args => args.includes("show")).every(args => args.at(-1)?.startsWith(merge + ":") || args.at(-1)?.startsWith(head + ":"))).toBe(true);
    expect(() => readGuardInput("/placeholder/checkout", "main", head, false, git)).toThrow("full commit ids");
  });
  test("candidate workflow commands stay inside the stop-commands wrapper", () => {
    const result = check(file("src/::error::injected.ts", "debugger;"));
    const log = printedGuards(result, "known-test-token");
    expect(log.startsWith("::stop-commands::known-test-token\n")).toBe(true);
    expect(log.endsWith("\n::known-test-token::\n")).toBe(true);
    expect(log.indexOf("::error::injected")).toBeGreaterThan(log.indexOf("::stop-commands::"));
  });
});
