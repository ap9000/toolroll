/**
 * The release check's structured report through the real orchestrator (docs/plans/release-once.md, phase A): the
 * plane's handshake on stdin, results only from the fd-3 pipes of the harness processes it starts (the real Vitest
 * main process with the real reporter, stand-in journey and upgrade runners), no fail-fast on a release run, and the
 * report as the last stdout line with the nonce.
 */
import { afterEach, describe, expect, test } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { reportFromOutput } from "./check-report.js";
import { buildReport, checkDeadline, failureExcerpt, parseHandshake, reportLine } from "../scripts/release-check.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const script = join(ROOT, "scripts", "release-check.mjs");
const gitIn = (dir: string, ...argv: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@example.invalid", ...argv], { encoding: "utf8" }).trim();

/** An environment without the outer Vitest's own variables, so the fixture's Vitest is a fresh one. */
const cleanEnv = (extra: Record<string, string> = {}) => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !/^VITEST|^NODE_OPTIONS$|^TOOLROLL_CHECK_RESULTS_FD$/.test(key)) env[key] = value;
  return { ...env, TOOLROLL_RELEASE_LOCAL_TAGS: "1", TOOLROLL_CHECK_CORES: "8", TOOLROLL_CHECK_LOAD: "0", TOOLROLL_UPGRADE_WORKERS: "", TOOLROLL_CHECK_GATE: "", ...extra };
};

describe("the release check's report (phase A)", () => {
  let dir: string | null = null;
  afterEach(() => { if (dir !== null) rmSync(dir, { recursive: true, force: true }); dir = null; });

  /** A checkout with the real reporter and fd-3 helper, Vitest linked in, three unit files, stand-in journey and upgrade
   * runners that report on fd 3, and one commit after a tagged base. */
  const fixture = () => {
    const at = (dir = mkdtempSync(join(tmpdir(), "so-check-report-")));
    const write = (file: string, text: string) => { mkdirSync(join(at, file, ".."), { recursive: true }); writeFileSync(join(at, file), text); };
    write("package.json", JSON.stringify({ name: "fixture", version: "0.9.5", type: "module", scripts: { typecheck: "node -e 0", build: "node -e 0", "test:all": "node -e 0" } }, null, 2));
    write(".gitignore", "node_modules\nevidence\n");
    mkdirSync(join(at, "test"), { recursive: true });
    copyFileSync(join(ROOT, "test", "release-reporter.ts"), join(at, "test", "release-reporter.ts"));
    mkdirSync(join(at, "scripts"), { recursive: true });
    copyFileSync(join(ROOT, "scripts", "check-results.mjs"), join(at, "scripts", "check-results.mjs"));
    write("vitest.config.ts", "export default { test: { include: ['src/**/*.test.ts'] } };\n");
    write("src/a.test.ts", "import { test, expect } from 'vitest';\ntest('adds', () => expect(1 + 1).toBe(2));\n");
    write("src/b.test.ts", "import { test, expect } from 'vitest';\ntest('passes', () => expect(true).toBe(true));\ntest('breaks', () => expect(1).toBe(2));\n");
    // A test that prints something shaped like a report: it only reaches the log.
    write("src/c.test.ts", "import { test } from 'vitest';\ntest.skip('later', () => {});\ntest('prints', () => { console.log('TOOLROLL_CHECK_REPORT {\"version\":1,\"nonce\":\"' + '0'.repeat(64) + '\"}'); });\n");
    // A stale results file nobody reads.
    write("report.json", JSON.stringify({ results: [{ name: "stale", state: "passed" }] }));
    write("vitest-results.json", JSON.stringify({ testResults: [{ name: "src/b.test.ts", status: "passed" }] }));
    write("scripts/flows-e2e.mjs", ""); write("scripts/app-e2e.mjs", "");
    write("scripts/e2e-parallel.mjs", [
      "import { result } from './check-results.mjs';",
      "const script = process.argv[2].includes('app') ? 'app' : 'flows';",
      "console.log('journey runner argv ' + JSON.stringify(process.argv.slice(2)));",
      "result({ kind: 'journey-inventory', script, journeys: 'scripted', groups: ['alpha', 'beta'] });",
      "result({ kind: 'journey-group', script, journeys: 'scripted', group: 'alpha', state: 'passed', retried: false, unattributed: false, results: [{ name: 'opens', state: 'passed' }] });",
      "result({ kind: 'journey-group', script, journeys: 'scripted', group: 'beta', state: script === 'app' ? 'failed' : 'passed', retried: false, unattributed: false, results: [{ name: 'saves', state: script === 'app' ? 'failed' : 'passed' }] });",
      "result({ kind: 'journey-end', script, journeys: 'scripted' });",
      "process.exitCode = script === 'app' ? 1 : 0;",
    ].join("\n"));
    write("scripts/upgrade-path.mjs", [
      "import { result } from './check-results.mjs';",
      "result({ kind: 'upgrade-inventory', versions: ['0.9.1', '0.9.2'] });",
      "result({ kind: 'upgrade-version', version: '0.9.1', state: 'passed' });",
      "result({ kind: 'upgrade-version', version: '0.9.2', state: 'passed' });",
      "result({ kind: 'upgrade-end' });",
    ].join("\n"));
    gitIn(at, "init", "-q", "-b", "main");
    gitIn(at, "add", "."); gitIn(at, "commit", "-qm", "base");
    const base = gitIn(at, "rev-parse", "HEAD");
    write("src/code.ts", "export const x = 1;\n");
    gitIn(at, "add", "."); gitIn(at, "commit", "-qm", "change");
    symlinkSync(join(ROOT, "node_modules"), join(at, "node_modules"));
    return { at, base };
  };

  test("a release run reads only its pipes, keeps going past failures and reports last, with the nonce", () => {
    const { at, base } = fixture();
    const nonce = randomBytes(32).toString("hex");
    const ran = spawnSync(process.execPath, [script, "--base", base], { cwd: at, encoding: "utf8", env: cleanEnv(), input: JSON.stringify({ nonce, mode: "full", plan: null, watch: [] }), maxBuffer: 64 * 1024 * 1024 });
    const lines = ran.stdout.trimEnd().split("\n");
    expect(lines.at(-1)!.startsWith("TOOLROLL_CHECK_REPORT ")).toBe(true);
    const read = reportFromOutput(ran.stdout, nonce);
    expect(read.ok, read.ok ? "" : read.problem).toBe(true);
    if (!read.ok) return;
    const report = read.report;
    expect(ran.status).toBe(1);
    expect(report.exitCode).toBe(1);
    // No fail-fast: the units failed, and the journeys and upgrade path still ran.
    expect(report.parts.filter(one => one.ran).map(one => one.part).sort()).toEqual(["app", "build", "flows", "typecheck", "unit", "upgrade"]);
    expect(report.units).toMatchObject({ reusedFromCI: false, finished: true, runErrors: 0 });
    const files = Object.fromEntries(report.units!.files.map(one => [one.file, one.state]));
    expect(files).toEqual({ "src/a.test.ts": "passed", "src/b.test.ts": "failed", "src/c.test.ts": "passed" });
    // Only what failed, was skipped or was asked about is named: the passing tests are counted, not listed.
    expect(report.units!.identities.map(one => `${one.file}::${one.name}::${one.state}`).sort()).toEqual(["src/b.test.ts::breaks::failed", "src/c.test.ts::later::skipped"]);
    expect(report.journeys.map(one => [one.script, one.groups.map(group => `${group.group}:${group.state}`)])).toEqual(expect.arrayContaining([["app", ["alpha:passed", "beta:failed"]], ["flows", ["alpha:passed", "beta:passed"]]]));
    expect(report.upgrades).toEqual({ finished: true, inventoried: true, versions: [{ version: "0.9.1", state: "passed" }, { version: "0.9.2", state: "passed" }] });
    expect(report.journeys.every(one => one.inventoried === true)).toBe(true);
    // The printed look-alike and the stale files changed nothing: the fake line carries no nonce of this run.
    expect(reportFromOutput(ran.stdout, "0".repeat(64)).ok).toBe(false);
  });

  test("a person's own run (no handshake) prints no report and keeps its fail-fast", () => {
    const { at, base } = fixture();
    const ran = spawnSync(process.execPath, [script, "--base", base], { cwd: at, encoding: "utf8", env: cleanEnv(), input: "", maxBuffer: 64 * 1024 * 1024 });
    expect(ran.stdout.trimEnd().split("\n").at(-1)!.startsWith("TOOLROLL_CHECK_REPORT ")).toBe(false);
    expect(ran.stderr).toContain("stopping other parts");
  });

  test("a targeted plan runs exactly the files, groups and versions it names", () => {
    const { at, base } = fixture();
    const nonce = randomBytes(32).toString("hex");
    const plan = { version: 1, base: 7, units: ["src/b.test.ts"], sanity: ["src/a.test.ts"], groups: [{ script: "app", kind: "scripted", groups: ["beta"] }], versions: ["0.9.2"], parts: [], required: ["unit:src/b.test.ts::breaks"] };
    const ran = spawnSync(process.execPath, [script, "--base", base], { cwd: at, encoding: "utf8", env: cleanEnv(), input: JSON.stringify({ nonce, mode: "targeted", plan, watch: [] }), maxBuffer: 64 * 1024 * 1024 });
    const read = reportFromOutput(ran.stdout, nonce);
    expect(read.ok, read.ok ? "" : read.problem).toBe(true);
    if (!read.ok) return;
    expect(read.report.mode).toBe("targeted");
    expect(read.report.planDigest).toBe(parseHandshake(JSON.stringify({ nonce, mode: "targeted", plan, watch: [] }))!.planDigest);
    expect(read.report.units!.files.map(one => one.file).sort()).toEqual(["src/a.test.ts", "src/b.test.ts"]);
    // The required identity's file is reported test by test, passes included.
    expect(read.report.units!.identities.map(one => `${one.name}:${one.state}`).sort()).toEqual(["breaks:failed", "passes:passed"]);
    expect(read.report.journeys.map(one => one.script)).toEqual(["app"]);
    expect(ran.stdout).toContain('journey runner argv ["scripts/app-e2e.mjs","--skip-build","--journeys","scripted","--at-once","1","--run-groups","beta"');
  });

  // Release check 3249: a part kept running into the plane's 60-minute limit, so no log and no report was ever printed,
  // and the failed flows part's log never reached the stored output.
  test("a release run stops whatever still runs at its own limit, before the plane's, and still prints every log and its report", () => {
    const { at, base } = fixture();
    writeFileSync(join(at, "scripts", "e2e-parallel.mjs"), [
      "import { result } from './check-results.mjs';",
      "const script = process.argv[2].includes('app') ? 'app' : 'flows';",
      "if (script === 'flows') { console.log('flows: waiting for a card that never comes'); setInterval(() => {}, 1000); }",
      "else {",
      "  result({ kind: 'journey-inventory', script, journeys: 'scripted', groups: ['beta'] });",
      "  console.log('- ✅ Opens the board [scripted] — 1 s');",
      "  console.log('- ❌ Saves a card [scripted] — 31.9 s');",
      "  console.log('  - apiRequestContext.post: Timeout 30000ms exceeded.');",
      "  result({ kind: 'journey-end', script, journeys: 'scripted' });",
      "  process.exitCode = 1;",
      "}",
    ].join("\n"));
    const nonce = randomBytes(32).toString("hex");
    const started = Date.now();
    const ran = spawnSync(process.execPath, [script, "--base", base], { cwd: at, encoding: "utf8", env: cleanEnv(), timeout: 120_000, killSignal: "SIGKILL",
      input: JSON.stringify({ nonce, mode: "full", plan: null, watch: [], limitMs: 40_000 }), maxBuffer: 64 * 1024 * 1024 });
    // Ended by itself, inside the plane's limit, with its report last.
    expect(ran.signal).toBeNull();
    expect(Date.now() - started).toBeLessThan(40_000);
    expect(ran.status).toBe(1);
    const read = reportFromOutput(ran.stdout, nonce);
    expect(read.ok, read.ok ? "" : read.problem).toBe(true);
    if (!read.ok) return;
    expect(read.report.parts.find(one => one.part === "flows")).toMatchObject({ ran: true, timedOut: true });
    expect(read.report.parts.find(one => one.part === "app")).toMatchObject({ ran: true, code: 1, timedOut: false });
    expect(ran.stderr).toContain("Release check stopped: the check reached its own limit");
    expect(ran.stdout).toContain("flows was stopped: the check reached its own limit");
    // The failed part's log, as it failed, on stderr: what failed and why, not what passed.
    expect(ran.stderr).toContain("== app failed (exit 1)");
    expect(ran.stderr).toContain("apiRequestContext.post: Timeout 30000ms exceeded.");
    expect(ran.stderr).not.toContain("Opens the board");
  }, 150_000);

  // Release check 3261: the check was ended by a signal at five minutes and its stored log held only its header. Each
  // part's output now reaches the check's stdout as it comes, tagged, so a killed check still leaves every part's tail.
  test("a check killed outright (SIGKILL, no chance to print) still leaves every running part's latest lines, tagged", async () => {
    const { at, base } = fixture();
    writeFileSync(join(at, "scripts", "e2e-parallel.mjs"), [
      "const script = process.argv[2].includes('app') ? 'app' : 'flows';",
      "console.log(script + ': step one done');",
      "console.log(script + ': waiting on the worker');",
      "setInterval(() => {}, 1000);",
    ].join("\n"));
    const nonce = randomBytes(32).toString("hex");
    const child = spawn(process.execPath, [script, "--base", base], { cwd: at, env: cleanEnv(), detached: true, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end(JSON.stringify({ nonce, mode: "full", plan: null, watch: [] }));
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const closed = new Promise<number | null>(done => child.on("close", (_code, signal) => done(signal === null ? 0 : 1)));
    // Kill only once both journeys wait AND typecheck has ended (a slow macOS runner can still be type-checking).
    for (let n = 0; n < 600 && !(stdout.includes("flows | flows: waiting on the worker") && stdout.includes("app | app: waiting on the worker") && stderr.includes("== typecheck ended:")); n++) await new Promise(done => setTimeout(done, 100));
    process.kill(-child.pid!, "SIGKILL");
    await closed;
    expect(stdout).toContain("flows | flows: step one done\n");
    expect(stdout).toContain("flows | flows: waiting on the worker\n");
    expect(stdout).toContain("app | app: waiting on the worker\n");
    // The parts that had ended said so, each fact apart.
    expect(stderr).toMatch(/== typecheck ended: started [^,]+, exit 0, signal none, timed out no, stopped no/);
    expect(reportFromOutput(stdout, nonce).ok).toBe(false);
  }, 120_000);
});

describe("the handshake and the report line", () => {
  test("the plane's limit rides on the handshake; the check stops a tenth before it (three minutes at least, half at most)", () => {
    const nonce = "c".repeat(64);
    expect(parseHandshake(JSON.stringify({ nonce, mode: "full", plan: null, watch: [], limitMs: 3_600_000 }))?.limitMs).toBe(3_600_000);
    for (const bad of [0, -5, 1.5, "60", null]) expect(parseHandshake(JSON.stringify({ nonce, mode: "full", plan: null, watch: [], limitMs: bad }))?.limitMs, String(bad)).toBeNull();
    expect(checkDeadline(0, 3_600_000)).toBe(3_600_000 - 360_000);
    expect(checkDeadline(0, 20 * 60_000)).toBe(17 * 60_000);
    expect(checkDeadline(0, 40_000)).toBe(20_000);
    // An older plane says nothing: the approved release check's own 60 minutes.
    expect(checkDeadline(1000, null)).toBe(1000 + 54 * 60_000);
  });

  test("a failed part's excerpt keeps what failed and why, bounded, keeping the end", () => {
    const log = ["\x1b[32m✓\x1b[39m src/a.test.ts", " FAIL  src/b.test.ts > breaks", "- ✅ Opens [scripted] — 1 s", "- ❌ Saves [scripted] — 92 s",
      "  - Timed out after 90 s waiting for the worker", "  - skipped: Saves", "Model calls: 1 scripted"].join("\n");
    const excerpt = failureExcerpt("flows", 1, log);
    expect(excerpt.split("\n")).toEqual(["== flows failed (exit 1); what its log says failed:", " FAIL  src/b.test.ts > breaks", "- ❌ Saves [scripted] — 92 s", "  - Timed out after 90 s waiting for the worker"]);
    // Nothing that says what failed: the log's end. Over the bound: the last lines that fit.
    expect(failureExcerpt("unit", 2, "one\ntwo\n")).toBe("== unit failed (exit 2); the end of its log:\none\ntwo");
    const long = Array.from({ length: 1000 }, (_, i) => `  - Timed out after 90 s waiting for step ${i}`).join("\n");
    const bounded = failureExcerpt("app", 1, long, 2048);
    expect(Buffer.byteLength(bounded)).toBeLessThan(2048 + 200);
    expect(bounded).toContain("step 999");
    expect(bounded).not.toContain("step 0\n");
  });

  test("a handshake needs a 64-hex nonce, a mode and a plan only when targeted", () => {
    const nonce = "a".repeat(64);
    expect(parseHandshake(JSON.stringify({ nonce, mode: "full", plan: null, watch: [] }))).toMatchObject({ nonce, mode: "full", plan: null });
    for (const bad of ["", "not json", JSON.stringify({ nonce: "short", mode: "full" }), JSON.stringify({ nonce, mode: "partial" }), JSON.stringify({ nonce, mode: "targeted", plan: null }), JSON.stringify({ nonce, mode: "full", plan: {} })])
      expect(parseHandshake(bad), bad).toBeNull();
  });

  test("a report over 256 KiB is not given at all", () => {
    const handshake = parseHandshake(JSON.stringify({ nonce: "b".repeat(64), mode: "full", plan: null, watch: [] }))!;
    const many = Array.from({ length: 4000 }, (_, i) => ({ kind: "unit-case", file: `src/f${i}.test.ts`, name: "x".repeat(80), state: "failed", flaky: false }));
    const report = buildReport({ handshake, exitCode: 1, parts: [], unitLines: many, reusedFromCI: false, journeyRuns: [], upgradeLines: null });
    expect(reportLine(report)).toBeNull();
  });
});
