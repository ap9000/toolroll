/**
 * The plane's side of the release check's report (docs/plans/release-once.md, phase A): the attempt row sealed before a
 * check runs (intended mode, nonce hash, the inventory read from the verified tree, the context), the report read only
 * from the last line carrying this run's nonce, and the sealed artifacts.
 */
import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, checkAttemptOf, type Store } from "./store.js";
import {
  CHECK_INVENTORY_CAPTURE, CHECK_REPORT_CAPTURE, payloadDigest, prepareCheckAttempt, readSealedJson,
  fullCheckProblem, reportFromOutput, sealCheckOutcome, treeFactsOf, projectGitDir,
} from "./check-report.js";

const NOW = new Date("2026-10-25T10:00:00.000Z");
const git = (dir: string, ...argv: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@example.invalid", ...argv], { encoding: "utf8" }).trim();

let dir: string | null = null;
afterEach(() => { if (dir !== null) rmSync(dir, { recursive: true, force: true }); dir = null; });

/** A project with unit files, attack tests, a harness that imports a helper, and a lockfile; and a store with one run. */
function setup(): { repo: string; head: string; store: Store; runId: number; root: string } {
  dir = mkdtempSync(join(tmpdir(), "so-check-attempt-"));
  const repo = join(dir, "project");
  const files: Record<string, string> = {
    "src/a.ts": "export const a = 1;\n",
    "src/a.test.ts": "test('a', () => {});\n",
    "src/b.slow.test.ts": "test('b', () => {});\n",
    "test/attacks/c.test.ts": "test('c', () => {});\n",
    "test/attacks/harness.ts": "export {};\n",
    "scripts/release-check.mjs": "import { x } from './helper.mjs';\nimport './check-results.mjs';\n",
    "scripts/helper.mjs": "export const x = 1;\n",
    "scripts/check-results.mjs": "export {};\n",
    "scripts/other.mjs": "export {};\n",
    "vitest.config.ts": "export default {};\n",
    "package-lock.json": "{}\n",
  };
  for (const [path, text] of Object.entries(files)) { mkdirSync(join(repo, path, ".."), { recursive: true }); writeFileSync(join(repo, path), text); }
  git(repo, "init", "-q"); git(repo, "add", "-A"); git(repo, "commit", "-qm", "candidate");
  const store = openStore(join(dir, "orders.db"));
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", NOW);
  store.createTask({ id: "release-0.9.71-abc1234", title: "Release" }, NOW);
  const ref = store.refFor("built-in", "release-0.9.71-abc1234").id;
  store.placeTask(ref, repo, {}, NOW);
  const runId = store.startRun({ taskRef: ref, leaseId: "l", runner: "r", branch: "b", worktree: "/pool/x", route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now: NOW });
  return { repo, head: git(repo, "rev-parse", "HEAD"), store, runId, root: join(dir, "evidence") };
}

describe("the check attempt, sealed before the check runs", () => {
  test("the inventory comes from the verified tree and Vitest's include globs; the harness digest covers everything else", () => {
    const { repo, head, store } = setup();
    const facts = treeFactsOf(projectGitDir(repo)!, head);
    expect(facts.ok).toBe(true);
    if (!facts.ok) return;
    expect(facts.facts.units).toEqual(["src/a.test.ts", "src/b.slow.test.ts", "test/attacks/c.test.ts"]);
    expect(facts.facts.harness).toEqual(["package-lock.json", "scripts/check-results.mjs", "scripts/helper.mjs", "scripts/other.mjs", "scripts/release-check.mjs", "src/a.ts", "test/attacks/harness.ts", "vitest.config.ts"]);
    expect(facts.facts.lockfile).toMatch(/^[0-9a-f]{40}$/);
    store.close();
  });

  test("intended mode, nonce hash, inventory and context are written before the command, and the nonce rides only on stdin", () => {
    const { repo, head, store, runId, root } = setup();
    const command = store.setVerifyCommand({ repo, command: "node scripts/release-check.mjs", timeoutMs: 60_000, approvedBy: "alex" }, NOW);
    const prepared = prepareCheckAttempt(store, root, { runId, repo, head, command, access: "sandboxed" }, NOW)!;
    expect(prepared).not.toBeNull();
    const handshake = JSON.parse(prepared.stdin) as { nonce: string; mode: string; plan: unknown };
    expect(handshake).toEqual({ nonce: prepared.nonce, mode: "full", plan: null, watch: [], limitMs: 60_000 });
    const row = checkAttemptOf(store, runId)!;
    expect(row).toMatchObject({ mode: "full", baseRun: null, planDigest: null, inventoryDigest: payloadDigest(prepared.inventory), contextDigest: payloadDigest(prepared.context) });
    expect(row.nonceHash).toBe(createHash("sha256").update(prepared.nonce).digest("hex"));
    expect(row.nonceHash).not.toBe(prepared.nonce);
    expect(prepared.context).toMatchObject({ grant: { id: command.id, digest: command.digest }, access: "sandboxed" });
    // One attempt per run: a second preparation seals nothing new.
    expect(prepareCheckAttempt(store, root, { runId, repo, head, command, access: "sandboxed" }, NOW)).toBeNull();
    store.close();
  });

  test("a project whose Git directory can't be read gets no handshake (the check runs as it always has)", () => {
    const { head, store, runId, root, repo } = setup();
    const command = store.setVerifyCommand({ repo, command: "true", timeoutMs: 60_000, approvedBy: "alex" }, NOW);
    expect(prepareCheckAttempt(store, root, { runId, repo: join(repo, "missing"), head, command, access: "sandboxed" }, NOW)).toBeNull();
    expect(checkAttemptOf(store, runId)).toBeNull();
    store.close();
  });
});

describe("the report, read from the check's output", () => {
  const nonce = "a".repeat(64);
  const report = (extra: Record<string, unknown> = {}) => ({ version: 1, nonce, mode: "full", planDigest: null, exitCode: 0, parts: [], units: null, journeys: [], upgrades: null, ...extra });
  const line = (value: unknown) => `TOOLROLL_CHECK_REPORT ${JSON.stringify(value)}`;

  // Attack 15 (accidental damage): a test printing a look-alike, junk a leftover process writes after the end, and a
  // stale file on disk are all ignored; only the last line with this run's nonce is the report.
  test("only the last line carrying this run's nonce is the report; look-alikes and later junk are passed over", () => {
    const fake = line(report({ nonce: "f".repeat(64), exitCode: 0 }));
    const out = ["== unit", fake, line(report({ exitCode: 1 })), "a leftover process wrote this", fake, "TOOLROLL_CHECK_REPORT {not json", ""].join("\n");
    const read = reportFromOutput(out, nonce);
    expect(read.ok && read.report.exitCode).toBe(1);
    expect(reportFromOutput(["== unit", fake].join("\n"), nonce)).toEqual({ ok: false, problem: "The check gave no report for this run." });
  });

  test("a report that breaks its contract, or is over 256 KiB, is no report", () => {
    expect(reportFromOutput(line(report({ parts: [{ part: "everything" }] })), nonce).ok).toBe(false);
    expect(reportFromOutput(line(report({ units: { reusedFromCI: false, finished: true, runErrors: 0, files: [], identities: [{ file: "src/a.test.ts", name: "x".repeat(300_000), state: "passed", flaky: false }] } })), nonce).ok).toBe(false);
  });

  test("sealed after the run: the report (when its mode and exit agree) and the inventory with what the check declared", () => {
    const { repo, head, store, runId, root } = setup();
    const command = store.setVerifyCommand({ repo, command: "true", timeoutMs: 60_000, approvedBy: "alex" }, NOW);
    const prepared = prepareCheckAttempt(store, root, { runId, repo, head, command, access: "sandboxed" }, NOW)!;
    const good = { version: 1, nonce: prepared.nonce, mode: "full", planDigest: null, exitCode: 0, parts: [], units: null,
      journeys: [{ script: "app", kind: "scripted", finished: true, groups: [{ group: "alpha", state: "passed", retried: false, unattributed: false, journeys: [] }] }],
      upgrades: { finished: true, versions: [{ version: "0.9.1", state: "passed" }] } };
    // The exit code disagrees: no report is sealed, the inventory still is.
    expect(sealCheckOutcome(store, root, prepared, { stdout: line(good), exitCode: 1 }, NOW)).toBeNull();
    expect(readSealedJson(store, root, runId, CHECK_REPORT_CAPTURE)).toBeNull();
    expect(readSealedJson(store, root, runId, CHECK_INVENTORY_CAPTURE)!.value).toMatchObject({ declared: { groups: [], versions: [] } });
    store.close();
  });

  test("a valid report is sealed, and the inventory names the groups and versions it declared", () => {
    const { repo, head, store, runId, root } = setup();
    const command = store.setVerifyCommand({ repo, command: "true", timeoutMs: 60_000, approvedBy: "alex" }, NOW);
    const prepared = prepareCheckAttempt(store, root, { runId, repo, head, command, access: "sandboxed" }, NOW)!;
    const good = { version: 1, nonce: prepared.nonce, mode: "full", planDigest: null, exitCode: 0, parts: [], units: null,
      journeys: [{ script: "app", kind: "scripted", finished: true, groups: [{ group: "alpha", state: "passed", retried: false, unattributed: false, journeys: [] }] }],
      upgrades: { finished: true, versions: [{ version: "0.9.1", state: "passed" }] } };
    expect(sealCheckOutcome(store, root, prepared, { stdout: `noise\n${line(good)}\n`, exitCode: 0 }, NOW)).toMatchObject({ exitCode: 0 });
    expect(readSealedJson(store, root, runId, CHECK_REPORT_CAPTURE)!.value).toMatchObject({ nonce: prepared.nonce });
    expect(readSealedJson(store, root, runId, CHECK_INVENTORY_CAPTURE)!.value).toEqual({ version: 1, sealed: prepared.inventory,
      declared: { groups: [{ script: "app", kind: "scripted", groups: ["alpha"] }], versions: ["0.9.1"] } });
    store.close();
  });
});

// Security review (parser differential): a harness dependency reached by any road changes the context's harness
// digest. Nothing is traced through imports, so no shape of import can hide one.
describe("the harness digest has no import parser to get around", () => {
  const digestAfter = (change: Record<string, string>) => {
    const { repo, head, store } = setup();
    const before = treeFactsOf(projectGitDir(repo)!, head);
    for (const [path, text] of Object.entries(change)) { mkdirSync(join(repo, path, ".."), { recursive: true }); writeFileSync(join(repo, path), text); }
    git(repo, "add", "-A"); git(repo, "commit", "-qm", "change");
    const after = treeFactsOf(projectGitDir(repo)!, git(repo, "rev-parse", "HEAD"));
    store.close();
    if (!before.ok || !after.ok) throw new Error("unreadable");
    return { before: before.facts.harnessDigest, after: after.facts.harnessDigest };
  };
  test.each([
    ["a src/ helper the harness imports", { "src/a.ts": "export const a = 2;\n" }],
    ["a file reached by require()", { "scripts/release-check.mjs": "const h = require('./required.cjs');\n", "scripts/required.cjs": "module.exports = 1;\n" }],
    ["a file reached by a computed import()", { "scripts/computed.mjs": "export default 2;\n" }],
    ["a side-effect import's target", { "scripts/check-results.mjs": "export const changed = true;\n" }],
    ["a file behind an import a regex can't read", { "scripts/release-check.mjs": "import(/* x */ `./hel${'per'}.mjs`);\n", "scripts/helper.mjs": "export const x = 3;\n" }],
    ["a test/ helper nothing names", { "test/attacks/harness.ts": "export const changed = 1;\n" }],
    ["package.json", { "package.json": "{}\n" }],
    ["the lockfile", { "package-lock.json": "{\"changed\":1}\n" }],
    ["a tsconfig", { "tsconfig.json": "{}\n" }],
  ])("%s changes the digest", (_name, change) => {
    const { before, after } = digestAfter(change);
    expect(after).not.toBe(before);
  });
  test("a unit test, a journey script or a doc leaves it alone", () => {
    const { before, after } = digestAfter({ "src/a.test.ts": "test('a2', () => {});\n", "scripts/app-e2e.mjs": "// journeys\n", "docs/x.md": "# x\n" });
    expect(after).toBe(before);
  });
});

// Eval harness phase 1 (docs/plans/eval-harness.md, A): a Full release check qualifies only with a valid nonce'd report,
// a complete inventory, terminal results for every obligation and a successful exit. Anything less is "no result".
describe("a Full release check without a complete result has no result, never a pass", () => {
  const NONCE = "a".repeat(64);
  const UNIT_FILES = ["src/a.test.ts", "src/b.test.ts"];
  const inventory = { version: 1 as const, sealed: { version: 1 as const, units: UNIT_FILES, parts: ["typecheck", "build", "unit", "flows", "app", "flows-real", "app-real", "upgrade"] as const }, declared: { groups: [], versions: [] } };
  const part = (name: string, selected: boolean, extra: Record<string, unknown> = {}) => ({ part: name, selected, ran: selected, code: selected ? 0 : null, timedOut: false, ...extra });
  const passing = (over: Record<string, unknown> = {}) => ({
    version: 1, nonce: NONCE, mode: "full", planDigest: null, exitCode: 0,
    parts: [part("typecheck", true), part("build", true), part("unit", true), part("flows", true), part("app", false), part("flows-real", false), part("app-real", false), part("upgrade", true)],
    units: { reusedFromCI: false, finished: true, runErrors: 0, identities: [], files: UNIT_FILES.map(file => ({ file, state: "passed", passed: 1, failed: 0, skipped: 0, flaky: false })) },
    journeys: [{ script: "flows", kind: "scripted", finished: true, groups: [{ group: "alpha", state: "passed", retried: false, unattributed: false, journeys: [] }] }],
    upgrades: { finished: true, versions: [{ version: "0.9.1", state: "passed" }] },
    ...over,
  });
  /** The report as the plane would seal it: read from the check's stdout by this run's nonce, strictly. */
  const sealed = (stdout: string) => { const read = reportFromOutput(stdout, NONCE); return read.ok ? read.report : null; };
  const problem = (stdout: string, exitCode: number | null, inv: typeof inventory | null = inventory) => fullCheckProblem({ report: sealed(stdout), inventory: inv as never, exitCode });
  const out = (report: unknown) => `checks\nTOOLROLL_CHECK_REPORT ${JSON.stringify(report)}\n`;

  test("a complete, valid report with a successful exit qualifies", () => {
    expect(problem(out(passing()), 0)).toBeNull();
    // A failed check's valid report is its result (what it failed on), not "no result".
    expect(problem(out(passing({ exitCode: 1, parts: [part("typecheck", true, { code: 2 }), part("build", true), part("unit", true, { ran: false, code: null })] })), 1)).toBeNull();
  });

  test.each([
    // A crash: the check died before it printed a report (release check 3261: header only).
    ["a crash before the report", "Release check against v0.9.75 …\nUnits: local\n", 1],
    // Killed or stopped (the plane's limit, a signal): the plane saw no exit of its own.
    ["a cancelled or killed check (no exit of its own)", out(passing()), null],
    // Spawn failure: the command never started.
    ["a spawn failure (nothing printed)", "", 127],
    // Report loss: cut short in the middle of its line.
    ["a report cut short", out(passing()).slice(0, 200), 0],
    ["a malformed report", "TOOLROLL_CHECK_REPORT {not json\n", 0],
    // A candidate printing a fake report without this run's nonce, and fake result lines.
    ["a fake report without this run's nonce", out(passing({ nonce: "f".repeat(64) })), 0],
    ["fake result lines a test printed (a passing look-alike, unit lines on stdout)", `{"kind":"unit-file","file":"src/a.test.ts","state":"passed"}\nTest Files  2 passed (2)\nTOOLROLL_CHECK_REPORT {"version":1,"exitCode":0}\n`, 0],
    ["a report whose exit disagrees with the check's", out(passing({ exitCode: 0 })), 1],
    ["a targeted report for a full check", out(passing({ mode: "targeted" })), 0],
  ] as const)("%s: no result", (_name, stdout, exitCode) => {
    expect(problem(stdout, exitCode)).not.toBeNull();
  });

  test.each([
    ["a selected part that never ran", { parts: [part("typecheck", true), part("build", true), part("unit", true, { ran: false, code: null }), part("flows", true), part("app", false), part("flows-real", false), part("app-real", false), part("upgrade", true)] }],
    ["a part stopped by a signal", { parts: [part("typecheck", true), part("build", true), part("unit", true, { signal: "SIGKILL" }), part("flows", true), part("app", false), part("flows-real", false), part("app-real", false), part("upgrade", true)] }],
    ["a part that timed out", { parts: [part("typecheck", true), part("build", true), part("unit", true, { timedOut: true }), part("flows", true), part("app", false), part("flows-real", false), part("app-real", false), part("upgrade", true)] }],
    ["a part missing from the report", { parts: [part("typecheck", true), part("build", true), part("unit", true)] }],
    ["the typecheck reported as not selected", { parts: [part("typecheck", false), part("build", true), part("unit", true), part("flows", true), part("app", false), part("flows-real", false), part("app-real", false), part("upgrade", true)] }],
    ["a unit file with no result (truncated inventory)", { units: { reusedFromCI: false, finished: true, runErrors: 0, identities: [], files: [{ file: "src/a.test.ts", state: "passed", passed: 1, failed: 0, skipped: 0, flaky: false }] } }],
    ["a unit suite that didn't reach its end", { units: { reusedFromCI: false, finished: false, runErrors: 0, identities: [], files: UNIT_FILES.map(file => ({ file, state: "passed", passed: 1, failed: 0, skipped: 0, flaky: false })) } }],
    ["unit errors no test owned", { units: { reusedFromCI: false, finished: true, runErrors: 1, identities: [], files: UNIT_FILES.map(file => ({ file, state: "passed", passed: 1, failed: 0, skipped: 0, flaky: false })) } }],
    ["no unit report at all", { units: null }],
    ["a journey run that didn't reach its end", { journeys: [{ script: "flows", kind: "scripted", finished: false, groups: [] }] }],
    ["a journey group that never ran", { journeys: [{ script: "flows", kind: "scripted", finished: true, groups: [{ group: "alpha", state: "not-run", retried: false, unattributed: false, journeys: [] }] }] }],
    ["a selected journey script that reported nothing", { journeys: [] }],
    ["an upgrade version that never ran", { upgrades: { finished: true, versions: [{ version: "0.9.1", state: "not-run" }] } }],
    ["an upgrade path that didn't reach its end", { upgrades: { finished: false, versions: [] } }],
  ] as const)("exit 0 but %s: no result", (_name, over) => {
    expect(problem(out(passing(over as Record<string, unknown>)), 0)).not.toBeNull();
  });

  test("the sealed inventory unreadable: no result", () => {
    expect(problem(out(passing()), 0, null)).not.toBeNull();
  });
});
