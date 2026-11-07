/**
 * The skip rule a sandboxed Full check is held to (docs/plans/trusted-release-reports.md, H3, Codex round 1 finding 6):
 * the same case, by identity, or a reviewed exemption. Being in the same file is never enough.
 */
import { describe, expect, test } from "vitest";
import { downloadedReports, fullHandshake } from "../scripts/fenced-run.mjs";
import { parseHandshake } from "../scripts/release-check.mjs";
import { FENCED_SKIP_EXEMPTIONS, macosCases, measuredLevel, skipCoverage, skippedCases, unitCaseIdentity, uncoveredWords } from "./fenced-check-coverage.js";
import type { CheckReport } from "./contracts/release-check.js";

const ROOT = "/Users/runner/work/toolroll/toolroll";
const file = (path: string, cases: Record<string, unknown>[]) => ({ name: `${ROOT}/${path}`, assertionResults: cases });
const passing = (title: string, ancestors: string[] = []) => ({ title, ancestorTitles: ancestors, status: "passed" });

describe("the macOS CI's cases", () => {
  test("are named as the release check names them, `suite > test`, not by Vitest's spaced fullName", () => {
    const cases = macosCases([{ testResults: [file("src/a.test.ts", [{ ...passing("makes one", ["keychain", "chunks"]), fullName: "keychain chunks makes one" }])] }], ROOT);
    expect([...cases.keys()]).toEqual(["unit:src/a.test.ts::keychain > chunks > makes one"]);
  });
  test("a name twice in a file stands only if every one passed; a skipped case is no pass", () => {
    const cases = macosCases([{ testResults: [file("src/a.test.ts", [passing("same"), { ...passing("same"), status: "failed" }, { ...passing("skipped"), status: "skipped" }])] }], ROOT);
    expect(cases.get("unit:src/a.test.ts::same")).toBe(false);
    expect(cases.get("unit:src/a.test.ts::skipped")).toBe(false);
  });
  test("a file named outside the checkout counts for nothing", () => {
    expect(macosCases([{ testResults: [{ name: "/elsewhere/src/a.test.ts", assertionResults: [passing("x")] }] }], ROOT).size).toBe(0);
  });
});

describe("each skipped case", () => {
  const id = unitCaseIdentity("src/a.test.ts", "suite > keychain");
  test("is covered by the same case passing, exempt by the reviewed list, or not covered", () => {
    expect(skipCoverage([id], new Map([[id, true]]), [])).toEqual({ covered: [id], exempt: [], uncovered: [] });
    expect(skipCoverage([id], new Map(), [{ identity: id }])).toEqual({ covered: [], exempt: [id], uncovered: [] });
    expect(skipCoverage([id], new Map(), [])).toEqual({ covered: [], exempt: [], uncovered: [id] });
  });
  test.each([
    ["the same file, another case", new Map([[unitCaseIdentity("src/a.test.ts", "suite > other"), true]])],
    ["the case failing there", new Map([[id, false]])],
    ["the same name in another file", new Map([[unitCaseIdentity("src/b.test.ts", "suite > keychain"), true]])],
  ])("%s doesn't cover it", (_, macos) => { expect(skipCoverage([id], macos, []).uncovered).toEqual([id]); });
  test("a journey has no macOS CI case: it needs the list", () => {
    const journey = "journey:app:scripted:board::opens";
    expect(skipCoverage([journey], new Map([[id, true]]), []).uncovered).toEqual([journey]);
  });
  test("nothing is exempt until a measured run gives a reason", () => { expect(FENCED_SKIP_EXEMPTIONS).toEqual([]); });
  test("the words name the road on, and it is a person's", () => {
    expect(uncoveredWords([id])).toMatch(/check access.*password/);
    expect(uncoveredWords(Array.from({ length: 9 }, (_, at) => `unit:a::${at}`))).toMatch(/^9 cases.*and more/);
  });
});

test("a report's skips are its unit cases and journeys, by identity", () => {
  const report = {
    units: { identities: [{ file: "src/a.test.ts", name: "x", state: "skipped", flaky: false }, { file: "src/a.test.ts", name: "y", state: "passed", flaky: false }] },
    journeys: [{ script: "app", kind: "scripted", groups: [{ group: "board", journeys: [{ name: "opens", state: "skipped" }, { name: "closes", state: "passed" }] }] }],
  } as unknown as CheckReport;
  expect(skippedCases(report)).toEqual(["journey:app:scripted:board::opens", "unit:src/a.test.ts::x"]);
});

describe("the level a measurement allows", () => {
  test.each([
    ["sandboxed covered", [{ level: "sandboxed", passed: true, uncovered: 0 }], "sandboxed"],
    ["sandboxed short, sign-ins covered", [{ level: "sandboxed", passed: true, uncovered: 2 }, { level: "sign-ins", passed: true, uncovered: 0 }], "sign-ins"],
    ["sandboxed failed", [{ level: "sandboxed", passed: false, uncovered: 0 }], "unsandboxed"],
    ["nothing measured", [], "unsandboxed"],
    ["neither covered", [{ level: "sandboxed", passed: true, uncovered: 1 }, { level: "sign-ins", passed: true, uncovered: 1 }], "unsandboxed"],
  ] as const)("%s", (_, measured, level) => { expect(measuredLevel(measured)).toBe(level); });
});

describe("the harness", () => {
  test("its handshake is one the check accepts, owing every part, with nothing reused from CI", () => {
    const parsed = parseHandshake(JSON.stringify(fullHandshake("a".repeat(64), 60_000)));
    expect(parsed).toMatchObject({ mode: "full", ciSubstitute: false, limitMs: 60_000 });
    expect(parsed.owed).toEqual(expect.arrayContaining(["unit", "flows", "app", "upgrade"]));
  });
  test("a folder of anything but attempt-named macOS reports is refused", () => {
    expect(() => downloadedReports(import.meta.dirname)).toThrow(/unexpected/);
  });
});
