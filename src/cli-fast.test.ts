import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { quickAnswer } from "./cli-fast.js";
import { HELP } from "./cli.js";
import { PACKAGE_VERSION } from "./version.js";

const BIN = resolve("dist/bin.js");
const DIST = `${pathToFileURL(resolve("dist")).href}/`;
const VERSION = (JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { version: string }).version;
const CONNECTOR_SDKS = /\/node_modules\/(discord\.js|@slack\/socket-mode|imapflow|mailparser|nodemailer)\//;

let scratch: string;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "toolroll-cli-fast-"));
  // Records every module Node loads, so a test can say what a fast answer never opened.
  writeFileSync(join(scratch, "trace.mjs"), [
    'import { registerHooks } from "node:module";',
    'import { appendFileSync } from "node:fs";',
    'registerHooks({ load(url, context, next) { appendFileSync(process.env.TRACE_FILE, url + "\\n"); return next(url, context); } });',
  ].join("\n"));
  // Stands in for an older Node or for Bun, before the bin's own checks read process.versions.
  writeFileSync(join(scratch, "runtime.mjs"),
    'Object.defineProperty(process, "versions", { value: { ...process.versions, ...JSON.parse(process.env.FAKE_VERSIONS) } });\n');
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** One run of the built bin: its output, and every module it loaded (ours relative to dist/). */
type Run = { status: number | null; stdout: string; stderr: string; ours: string[]; all: string[] };

function runBin(args: readonly string[], versions?: Record<string, string>): Run {
  const trace = join(scratch, `trace-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(trace, "");
  const preloads = ["--import", join(scratch, "trace.mjs"), ...(versions ? ["--import", join(scratch, "runtime.mjs")] : [])];
  const result = spawnSync(process.execPath, [...preloads, BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, TRACE_FILE: trace, FAKE_VERSIONS: JSON.stringify(versions ?? {}) },
  });
  const all = readFileSync(trace, "utf8").split("\n").filter(Boolean);
  const ours = all.filter(url => url.startsWith(DIST)).map(url => url.slice(DIST.length)).sort();
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, ours, all };
}

describe("quickAnswer", () => {
  test("answers the version for --version and -v in first place, whatever follows", () => {
    expect(PACKAGE_VERSION).toBe(VERSION);
    expect(quickAnswer(["--version"])).toBe(VERSION);
    expect(quickAnswer(["-v"])).toBe(VERSION);
    expect(quickAnswer(["--version", "--json"])).toBe(VERSION);
  });

  test("leaves everything else to the CLI", () => {
    for (const argv of [[], ["--help", "--json"], ["task", "--help"], ["status"], ["help", "me"], ["x", "--version"], ["-o", "out.json", "--help"]]) {
      expect(quickAnswer(argv)).toBeNull();
    }
  });

});

describe("the bin's fast path", () => {
  test("--version and help print, exit 0 and never load the CLI or a command family", () => {
    for (const [args, expected] of [[["--version"], VERSION], [["-v"], VERSION], [["--help"], HELP], [["-h"], HELP], [["help"], HELP]] as const) {
      const run = runBin(args);
      expect(run.status).toBe(0);
      expect(run.stdout).toBe(`${expected}\n`);
      expect(run.stderr).toBe("");
      expect(run.ours).toEqual(["bin.js", "cli-fast.js", "cli-help.js", "scan.js", "version.js"]);
    }
  });

  test("the Node engine check still answers first, with exit 2", () => {
    const old = runBin(["--version"], { node: "22.12.0" });
    expect(old.status).toBe(2);
    expect(old.stdout).toBe("");
    expect(old.stderr).toBe("Toolroll needs Node 22.13 or newer (this is 22.12.0) — it uses node:sqlite.\n");
    expect(old.ours).toEqual(["bin.js"]);

    const bun = runBin(["--help"], { bun: "1.2.0" });
    expect(bun.status).toBe(2);
    expect(bun.stdout).toBe("");
    expect(bun.stderr).toContain("Bun's runtime has no node:sqlite");
    expect(bun.ours).toEqual(["bin.js"]);
  });

  test("anything else still runs the CLI: usage errors exit 2, envelopes are unchanged", () => {
    const bad = runBin(["--nope"]);
    expect(bad.status).toBe(2);
    expect(bad.stdout).toBe("unknown option --nope — try `toolroll --help`\n");
    expect(bad.ours).toContain("cli.js");

    const contract = runBin(["contract", "--json"]);
    expect(contract.status).toBe(0);
    expect(JSON.parse(contract.stdout)).toMatchObject({ ok: true, command: "contract" });
    // contract is not a queue command: the queue's module graph and the connector SDKs stay unloaded.
    expect(contract.ours).not.toContain("operate.js");
    expect(contract.all.filter(url => CONNECTOR_SDKS.test(url))).toEqual([]);
  });
});
