import { afterEach, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The scripts a flow's check zone runs to test Toolroll every night and week (scripts/flows/, docs/guide/flows.md).

let dir: string | null = null;
const folder = () => (dir = mkdtempSync(join(tmpdir(), "so-flow-check-scripts-")));
afterEach(() => { if (dir !== null) rmSync(dir, { recursive: true, force: true }); dir = null; });

/** A stand-in end-to-end suite with the real one's interface (--only, --output) and report (every result naming its needs). */
const STAND_IN = String.raw`
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2), option = name => { const at = args.indexOf(name); return at === -1 ? null : args[at + 1]; };
const out = option("--output"), only = option("--only") === null ? null : new RegExp(option("--only"), "i");
const dir = process.env.STAND_IN_DIR, tried = join(dir, "flaky-tried");
if (process.env.STAND_IN_HANGS === "1") await new Promise(done => setTimeout(done, 60_000));
mkdirSync(out, { recursive: true });
const JOURNEYS = [["Sign in (setup)", []], ["The lead draws a flow", ["Sign in (setup)"]], ["Independent", []], ["After the flow", ["The lead draws a flow"]], ["No browser errors on any page", []]];
const results = [], failed = new Set();
for (const [name, needs] of JOURNEYS) {
  if (only !== null && !only.test(name)) { results.push({ name, needs, state: "not selected" }); continue; }
  if (needs.some(one => failed.has(one))) { results.push({ name, needs, state: "skipped", because: needs.filter(one => failed.has(one)) }); failed.add(name); continue; }
  let ok = true;
  if (name === "The lead draws a flow") { ok = existsSync(tried) && process.env.STAND_IN_ALWAYS_FAILS !== "1"; writeFileSync(tried, ""); }
  if (!ok) failed.add(name);
  results.push({ name, needs, state: ok ? "passed" : "failed", ...(ok ? {} : { error: 'a failed script goes to review, not the build: [["Build","task","check",null],["Unit tests","check","review","review"]]' }) });
}
appendFileSync(join(dir, "runs.jsonl"), JSON.stringify(results.filter(one => one.state !== "not selected").map(one => one.name)) + "\n");
writeFileSync(join(out, "report.json"), JSON.stringify({ results: results.filter(one => one.state !== "not selected"), modelCalls: { turns: 3, scripted: 0, real: Number(process.env.STAND_IN_REAL_TURNS ?? 0), unscripted: 0 } }));
process.exitCode = failed.size > 0 ? 1 : 0;
`;

describe("real-model-journeys.mjs", () => {
  const journeys = (env: Record<string, string>, extra: string[] = []) => {
    const at = folder();
    writeFileSync(join(at, "stand-in-e2e.mjs"), STAND_IN);
    const ran = spawnSync(process.execPath, [resolve("scripts/flows/real-model-journeys.mjs"), "--no-build", "--suite", `flows=${join(at, "stand-in-e2e.mjs")}`, "--output", join(at, "out"), ...extra],
      { encoding: "utf8", env: { ...process.env, STAND_IN_DIR: at, ...env }, timeout: 60_000 });
    const runs = existsSync(join(at, "runs.jsonl")) ? readFileSync(join(at, "runs.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]) : [];
    return { code: ran.status, stdout: ran.stdout, runs };
  };

  test("a journey that fails once runs again with its setup journey, and the run passes", () => {
    const { code, stdout, runs } = journeys({}, ["--only", "^(?!Independent)"]);
    expect(code).toBe(0);
    expect(runs[0]).toEqual(["Sign in (setup)", "The lead draws a flow", "After the flow", "No browser errors on any page"]);
    // The second try, its --only in place of the first's: the failed journey, the setup it needs, the one skipped because of it, and the browser check.
    expect(runs[1]).toEqual(["Sign in (setup)", "The lead draws a flow", "After the flow", "No browser errors on any page"]);
    expect(stdout).toContain("Every real-model journey passed (flows 4)");
    expect(stdout).toContain("Flaky, passed on the second try: flows: The lead draws a flow");
    expect(stdout.trim().split("\n").at(-1)).toBe("goto: pass");
  });

  test("by default every group of both journey scripts is a suite with every journey and real models; the summary counts the real turns, retries included", () => {
    const listed = spawnSync(process.execPath, [resolve("scripts/flows/real-model-journeys.mjs"), "--suites"], { encoding: "utf8" });
    const suites = JSON.parse(listed.stdout) as { name: string; argv: string[] }[];
    const groupsOf = (script: string) => (JSON.parse(spawnSync(process.execPath, [resolve(script), "--groups", "--json"], { encoding: "utf8" }).stdout) as { name: string }[]).map(one => one.name);
    expect(suites).toEqual([
      ...groupsOf("scripts/flows-e2e.mjs").map(name => ({ name: `flows-${name}`, argv: ["scripts/flows-e2e.mjs", "--group", name, "--journeys", "all"] })),
      ...groupsOf("scripts/app-e2e.mjs").map(name => ({ name: `app-${name}`, argv: ["scripts/app-e2e.mjs", "--group", name, "--journeys", "all"] })),
    ]);
    const { code, stdout } = journeys({ STAND_IN_REAL_TURNS: "3" }, ["--only", "^(?!Independent)"]);
    expect(code).toBe(0);
    expect(stdout).toContain("\nReal model turns: 6\n");
  });

  test("a journey that fails twice exits non-zero with the journey, its error and the zones it saw", () => {
    const { code, stdout, runs } = journeys({ STAND_IN_ALWAYS_FAILS: "1" });
    expect(code).toBe(1);
    expect(runs).toHaveLength(2);
    const lines = stdout.trim().split("\n");
    expect(lines.slice(0, 4)).toEqual([
      "1 journey failed twice (" + /\(([\d.]+ min)\)/.exec(lines[0]!)![1] + "):",
      "- flows: The lead draws a flow",
      "  error: a failed script goes to review, not the build",
      '  saw: [["Build","task","check",null],["Unit tests","check","review","review"]]',
    ]);
    expect(lines.at(-1)).toBe("goto: fail");
  });

  test("the time cap stops a suite and fails the run", () => {
    const { code, stdout } = journeys({ STAND_IN_HANGS: "1" }, ["--minutes", "0.03"]);
    expect(code).toBe(1);
    expect(stdout).toContain("- flows: the whole run\n  error: ran out of time at the 0.03-minute cap");
    expect(stdout.trim().split("\n").at(-1)).toBe("goto: fail");
  });
});

describe("weekly-upkeep.mjs", () => {
  /** npm and the three CLIs as stand-ins on PATH: each answers what the test wrote for it. */
  const upkeep = (answers: Record<string, string>, state: string) => {
    for (const [name, script] of Object.entries(answers)) { writeFileSync(join(dir!, name), `#!/bin/sh\n${script}\n`); chmodSync(join(dir!, name), 0o755); }
    const ran = spawnSync(process.execPath, [resolve("scripts/flows/weekly-upkeep.mjs"), "--state", state], { encoding: "utf8", env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir! }, timeout: 30_000 });
    return { code: ran.status, lines: ran.stdout.trim().split("\n") };
  };
  const npm = (outdated: string, audit: string) => `case "$1" in outdated) echo '${outdated}'; exit ${outdated === "{}" ? 0 : 1};; audit) echo '${audit}'; exit ${audit.includes('"severity"') ? 1 : 0};; esac`;

  test("with nothing to act on it records the CLI versions and exits 0; next week each change is one line and it exits non-zero", () => {
    const at = folder(), state = join(at, "kept", "weekly-upkeep.json");
    const quiet = upkeep({ npm: npm("{}", '{"vulnerabilities":{}}'), claude: "echo '2.1.281 (Claude Code)'", codex: "echo 'codex-cli 0.156.1'" }, state);
    expect(quiet).toEqual({ code: 0, lines: ["Nothing to act on this week."] });
    expect(JSON.parse(readFileSync(state, "utf8")).clis).toEqual({ claude: "2.1.281", codex: "0.156.1", gemini: null });

    const outdated = JSON.stringify({ vitest: { current: "4.1.10", wanted: "4.1.12", latest: "5.0.3" }, tsx: { current: "4.23.15", wanted: "4.23.15", latest: "4.23.15" } });
    const audit = JSON.stringify({ vulnerabilities: { "@vitest/mocker": { severity: "moderate", via: [{ title: "Path traversal via a redirect mock" }], fixAvailable: { name: "vitest", version: "4.1.11" } } } });
    const busy = upkeep({ npm: npm(outdated, audit), claude: "echo '2.1.286 (Claude Code)'", codex: "exit 127", gemini: "echo 0.60.0" }, state);
    expect(busy).toEqual({ code: 1, lines: [
      "Update vitest: 4.1.10 → 5.0.3 (4.1.12 within its range)",
      "Vulnerable @vitest/mocker (moderate): Path traversal via a redirect mock — fixed in vitest 4.1.11",
      "claude 2.1.281 → 2.1.286: check Toolroll still runs it (npm run certify:provider)",
      "codex 0.156.1 is no longer installed",
      "gemini (not installed) → 0.60.0: check Toolroll still runs it (npm run certify:provider)",
    ] });
  });

  test("npm that can't reach the registry is a thing to act on, not a quiet week", () => {
    const at = folder();
    const offline = upkeep({ npm: `echo '{"error":{"code":"ENOTFOUND","summary":"request to https://registry.npmjs.org failed"}}'; exit 1` }, join(at, "state.json"));
    expect(offline).toEqual({ code: 1, lines: ["npm outdated couldn't run: request to https://registry.npmjs.org failed", "npm audit couldn't run: request to https://registry.npmjs.org failed"] });
  });
});
