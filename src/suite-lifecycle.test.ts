/**
 * Suites leave nothing behind (scripts/suite-lifecycle.mjs, test/temp-root.ts): a suite that passes, fails, times out
 * or is interrupted ends with its temp root gone and no process it started still running — not even one that
 * ignores SIGTERM. Each case runs a real miniature suite in a subprocess and compares its temp folder and processes
 * before and after.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isTestTemp } from "./test-temp.js";

const LIFECYCLE = resolve("scripts/suite-lifecycle.mjs");
const SUITE = resolve("test/fixtures/suite-lifecycle/suite.mjs");
const VITEST_CONFIG = resolve("test/fixtures/suite-lifecycle/vitest.config.mjs");
const VITEST = resolve("node_modules/vitest/vitest.mjs");

let parent: string;
let reportFile: string;
beforeEach(() => {
  // The suite's TMPDIR parent: only this case writes here, so "before" and "after" are exact.
  parent = mkdtempSync(join(tmpdir(), "so-lifecycle-"));
  reportFile = join(mkdtempSync(join(tmpdir(), "so-lifecycle-report-")), "report.json");
});
const leftovers: number[] = [];
afterEach(() => {
  for (const pid of leftovers.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone, as it should be */ } }
  rmSync(parent, { recursive: true, force: true });
  rmSync(join(reportFile, ".."), { recursive: true, force: true });
});

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };

async function until(what: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!what()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise(done => setTimeout(done, 50));
  }
}

/** Run `argv` with TMPDIR = parent; `interrupt`: send SIGINT once the suite has said where its things are. */
async function runIn(argv: string[], options: { interrupt?: boolean; env?: Record<string, string> } = {}): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }> {
  const child = spawn(process.execPath, argv, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TMPDIR: parent, TMP: parent, TEMP: parent, ...options.env } });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output += String(chunk); });
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => child.on("exit", (code, signal) => done({ code, signal })));
  if (options.interrupt) {
    await until(() => existsSync(reportFile), 60_000);
    child.kill("SIGINT");
  }
  return { ...await ended, output };
}

function report(): { tmp: string; made: string; helper: number } {
  const read = JSON.parse(readFileSync(reportFile, "utf8")) as { tmp: string; made: string; helper: number };
  leftovers.push(read.helper);
  return read;
}

/** Nothing new in the suite's temp parent, nothing it started still running. */
async function nothingLeft(left: { tmp: string; made: string; helper: number }): Promise<void> {
  expect(left.tmp.startsWith(parent)).toBe(true);
  expect(left.tmp).not.toBe(parent);
  await until(() => !alive(left.helper), 5_000).catch(() => undefined);
  expect(alive(left.helper), `helper ${left.helper} still running`).toBe(false);
  expect(existsSync(left.made)).toBe(false);
  expect(existsSync(left.tmp)).toBe(false);
  expect(readdirSync(parent).filter(isTestTemp)).toEqual([]);
  expect(readdirSync(parent)).toEqual([]);
}

const supervised = (mode: string, extra: string[] = []) => [LIFECYCLE, "--grace", "0.5", ...extra, "--", process.execPath, SUITE, mode, reportFile];

test("a suite that passes leaves no temp folder and no process, even one that ignores SIGTERM", async () => {
  const done = await runIn(supervised("pass"));
  expect(done.code).toBe(0);
  await nothingLeft(report());
});

test("a suite that fails leaves nothing and its failure stands", async () => {
  const done = await runIn(supervised("fail"));
  expect(done.code).toBe(1);
  await nothingLeft(report());
});

test("a suite that runs past its time is stopped with everything it started, and fails", async () => {
  const done = await runIn(supervised("hang", ["--timeout", "2"]));
  expect(done.code).toBe(124);
  expect(done.output).toContain("timed out after 2 s");
  await nothingLeft(report());
});

test("an interrupted suite (SIGINT to its runner) is stopped and cleaned up before the runner exits", async () => {
  const done = await runIn(supervised("hang"), { interrupt: true });
  expect(done.code).toBe(130);
  await nothingLeft(report());
});

test("--keep keeps the suite's temp root on purpose", async () => {
  const done = await runIn(supervised("pass", ["--keep"]));
  expect(done.code).toBe(0);
  const left = report();
  expect(existsSync(left.tmp)).toBe(true);
  expect(readFileSync(join(left.tmp, ".toolroll-temp-owner"), "utf8")).toMatch(/"pid":\d+/);
  expect(existsSync(join(left.tmp, ".metadata_never_index"))).toBe(true);
  await until(() => !alive(left.helper), 5_000).catch(() => undefined);
  expect(alive(left.helper)).toBe(false);
});

const vitest = (mode: string, interrupt = false) => runIn([VITEST, "run", "--config", VITEST_CONFIG, "--reporter=dot"], { interrupt, env: { FIXTURE_MODE: mode, FIXTURE_REPORT: reportFile, TOOLROLL_RELEASE_BUILD: "" } });

test("a Vitest run that passes removes its temp root and what its tests started", async () => {
  const done = await vitest("pass");
  expect(done.code, done.output).toBe(0);
  await nothingLeft(report());
}, 120_000);

test("a Vitest run interrupted mid-test removes its temp root and stops what its tests started", async () => {
  const done = await vitest("hang", true);
  expect(done.code === 130 || done.signal === "SIGINT", done.output).toBe(true);
  await nothingLeft(report());
}, 120_000);

test("tempRoot: false runs a suite in its own process group without one more temp folder level (socket paths stay short)", async () => {
  const { runSuite } = await import("../scripts/suite-lifecycle.mjs");
  const seen = await runSuite({ command: process.execPath, args: ["-e", "process.stdout.write(process.env.TMPDIR ?? '')"], env: { TMPDIR: tmpdir() }, tempRoot: false });
  expect(seen.code).toBe(0);
  expect(seen.root).toBeNull();
  expect(seen.output.toString()).toBe(tmpdir());
  const own = await runSuite({ command: process.execPath, args: ["-e", "process.stdout.write(process.env.TMPDIR ?? '')"], prefix: "so-suite-" });
  expect(own.output.toString()).toBe(own.root);
  expect(existsSync(own.root)).toBe(false);
});
