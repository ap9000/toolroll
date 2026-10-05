import { afterEach, describe, expect, test } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GiveUp, groupAlive, processesIn, spawnOwned, stopGroups, until, waitFor } from "../scripts/e2e-kit.mjs";

// Regressions for the release gate's browser journeys (gate runs of 2026-09-29/30): a real-turn wait that ran out said only
// "locator.waitFor: Timeout 30000ms exceeded", and one flaky journey made e2e-parallel.mjs run its whole group again.

describe("a real-turn wait that runs out", () => {
  test("names what it waited for, for how long, and what it saw", async () => {
    let asked = 0;
    const waited = until("the lead's reply to “Add Leo”", async () => { asked++; return false; }, { timeoutMs: 600, everyMs: 100, seen: () => "0 new messages" });
    await expect(waited).rejects.toThrow("Timed out after 1 s waiting for the lead's reply to “Add Leo” — saw: 0 new messages");
    expect(asked).toBeGreaterThan(1);
  });

  test("a locator's wait names the wait and its seconds, not only the selector", async () => {
    const locator = { waitFor: async ({ timeout }: { timeout: number }) => { throw Object.assign(new Error(`locator.waitFor: Timeout ${timeout}ms exceeded.`), { name: "TimeoutError" }); } };
    await expect(waitFor(locator, "the card adding Leo in the lead's reply", { timeoutMs: 30_000, seen: () => "the reply “placeholder”" }))
      .rejects.toThrow("Timed out after 30 s waiting for the card adding Leo in the lead's reply — saw: the reply “placeholder”");
    const broken = { waitFor: async () => { throw new Error("Target page, context or browser has been closed"); } };
    await expect(waitFor(broken, "a card")).rejects.toThrow("Target page, context or browser has been closed");
  });

  test("ends at once, naming the wait, when what it waits for can no longer happen", async () => {
    const at = Date.now();
    await expect(until("the planner's updated plan", async () => { throw new GiveUp("planning is held for a person (plan-attempts-exhausted)"); }, { timeoutMs: 60_000, everyMs: 100 }))
      .rejects.toThrow("Gave up waiting for the planner's updated plan: planning is held for a person (plan-attempts-exhausted)");
    expect(Date.now() - at).toBeLessThan(5_000);
  });
});

/** A stand-in end-to-end script with the real one's interface: --groups --json, --group, --output, --only; it writes a
 * report like the kit's (every result naming its needs) and logs which journeys each run ran. */
const STAND_IN = String.raw`
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2), option = name => { const at = args.indexOf(name); return at === -1 ? null : args[at + 1]; };
const GROUPS = {
  alpha: [["Setup (with a $ and parentheses)", []], ["Flaky one", ["Setup (with a $ and parentheses)"]], ["Independent", []], ["After flaky", ["Flaky one"]]],
  beta: [["Beta works", []]],
  gamma: [["Gamma crashes first", []]],
};
if (args.includes("--groups")) { console.log(JSON.stringify(Object.keys(GROUPS).map(name => ({ name, journeys: GROUPS[name].length, about: name })))); process.exit(0); }
const group = option("--group"), out = option("--output"), only = option("--only") === null ? null : new RegExp(option("--only"), "i");
const dir = process.env.STAND_IN_DIR, mark = name => join(dir, name.replace(/\W+/g, "-"));
mkdirSync(out, { recursive: true });
// What a browser leaves in the temp folder (a profile), and how long the group holds its slot.
const start = Date.now();
writeFileSync(join(process.env.TMPDIR, "playwright_chromiumdev_profile-stand-in"), "x");
await new Promise(done => setTimeout(done, Number(process.env.STAND_IN_HOLD_MS ?? 0)));
if (group === "gamma" && !existsSync(mark("gamma-crashed"))) {
  writeFileSync(mark("gamma-crashed"), "");
  if (process.env.STAND_IN_LEAVES === "1") {
    // Killed outright with a console it started still running (no finally, no exit handler): the console is listed.
    const left = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", process.env.STAND_IN_BIN], { detached: true, stdio: "ignore" });
    writeFileSync(join(out, "processes.json"), JSON.stringify([{ group: left.pid, label: "serve" }]));
    writeFileSync(mark("leftover"), String(left.pid));
    process.kill(process.pid, "SIGKILL");
  }
  process.exit(3);
}
const leftover = existsSync(mark("leftover")) ? Number(readFileSync(mark("leftover"), "utf8")) : null;
const leftoverAlive = leftover !== null && (() => { try { process.kill(-leftover, 0); return true; } catch { return false; } })();
const results = [], failed = new Set();
for (const [name, needs] of [...GROUPS[group], ["No browser errors on any page", []]]) {
  if (name !== "No browser errors on any page" && only !== null && !only.test(name)) { results.push({ name, needs, state: "not selected" }); continue; }
  if (needs.some(one => failed.has(one))) { results.push({ name, needs, state: "skipped", because: needs.filter(one => failed.has(one)) }); failed.add(name); continue; }
  if (name === "Flaky one" && process.env.STAND_IN_SKIP_ON_RETRY === "1" && existsSync(mark("flaky-tried"))) { results.push({ name, needs, state: "skipped", because: ["the mail server container couldn't start"] }); continue; }
  let ok = true;
  // A console error that "Independent" logs, caught only by the browser check.
  if (name === "No browser errors on any page" && process.env.STAND_IN_CONSOLE_ERROR === "1" && results.some(one => one.name === "Independent" && one.state === "passed")) ok = false;
  if (name === "Flaky one") { ok = existsSync(mark("flaky-tried")) && process.env.STAND_IN_ALWAYS_FAILS !== "1"; writeFileSync(mark("flaky-tried"), ""); }
  if (!ok) failed.add(name);
  results.push({ name, needs, state: ok ? "passed" : "failed", ...(ok ? {} : { error: "Timed out after 1 s waiting for the card" }) });
  console.log((ok ? "PASS  " : "FAIL  ") + name);
}
appendFileSync(join(dir, "runs.jsonl"), JSON.stringify({ group, out, ran: results.filter(one => one.state !== "not selected").map(one => one.name), tmp: process.env.TMPDIR, start, end: Date.now(), ...(leftover === null ? {} : { leftoverAlive }) }) + "\n");
const kept = results.filter(one => one.state !== "not selected");
writeFileSync(join(out, "report.json"), JSON.stringify({ results: kept }));
writeFileSync(join(out, "report.md"), "# " + group + "\n" + kept.map(one => "- " + one.state + " " + one.name).join("\n") + "\n");
process.exitCode = kept.some(one => one.state === "failed") ? 1 : 0;
`;

describe("e2e-parallel.mjs", () => {
  let dir: string | null = null;
  afterEach(() => { if (dir !== null) rmSync(dir, { recursive: true, force: true }); dir = null; });

  type Run = { group: string; out: string; ran: string[]; tmp: string; start: number; end: number; leftoverAlive?: boolean };
  const GB = 1024 ** 3;
  /** The stand-in and the machine's readings it runs on (TOOLROLL_CHECK_MACHINE): an idle machine unless a test says. */
  const prepare = (machine: object = { platform: "linux", pressure: null, available: 32 * GB, swapUsed: 0, swapTotal: 8 * GB, providers: 0 }) => {
    dir = mkdtempSync(join(tmpdir(), "so-e2e-parallel-"));
    writeFileSync(join(dir, "stand-in-e2e.mjs"), STAND_IN);
    writeFileSync(join(dir, "machine.json"), JSON.stringify(machine));
    return { script: join(dir, "stand-in-e2e.mjs"), env: { ...process.env, NODE_OPTIONS: "", STAND_IN_DIR: dir, STAND_IN_BIN: resolve("dist/bin.js"), TOOLROLL_CHECK_MACHINE: join(dir, "machine.json"), TOOLROLL_CHECK_GATE: "", TOOLROLL_CHECK_PROVIDERS: "" } };
  };
  const runsIn = (at: string) => !existsSync(join(at, "runs.jsonl")) ? [] : readFileSync(join(at, "runs.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as Run);
  const runParallel = (env: Record<string, string> = {}, extra: string[] = [], machine?: object) => {
    const { script, env: base } = prepare(machine);
    let stdout: string, code = 0;
    try {
      stdout = execFileSync(process.execPath, [resolve("scripts/e2e-parallel.mjs"), script, "--output", join(dir!, "out"), ...extra], { encoding: "utf8", env: { ...base, ...env } });
    } catch (error) {
      const failed = error as { status: number; stdout: string };
      stdout = failed.stdout; code = failed.status;
    }
    return { stdout, code, runs: runsIn(dir!) };
  };
  /** Whether any two runs were going at the same time. */
  const overlapped = (runs: Run[]) => { const spans = [...runs].sort((a, b) => a.start - b.start); return spans.some((one, at) => at > 0 && one.start < spans[at - 1]!.end); };

  test("retries only a failed journey, with what it needs and what it held up, and names it flaky when it then passes", () => {
    const { stdout, code, runs } = runParallel();
    expect(code).toBe(0);
    const alpha = runs.filter(one => one.group === "alpha");
    expect(alpha).toHaveLength(2);
    expect(alpha[0]!.ran).toEqual(["Setup (with a $ and parentheses)", "Flaky one", "Independent", "After flaky", "No browser errors on any page"]);
    // The retry: the failed journey, what it needs, what was skipped because of it and the browser check; never Independent.
    expect(alpha[1]!.out).toBe(join(dir!, "out", "alpha-retry"));
    expect(alpha[1]!.ran).toEqual(["Setup (with a $ and parentheses)", "Flaky one", "After flaky", "No browser errors on any page"]);
    // A passing group runs once; a group that left no report runs again whole.
    expect(runs.filter(one => one.group === "beta")).toHaveLength(1);
    expect(runs.filter(one => one.group === "gamma")).toHaveLength(1);
    expect(existsSync(join(dir!, "out", "gamma-retry", "report.json"))).toBe(true);
    expect(stdout).toContain("Retrying alpha: 3 journeys — Setup (with a $ and parentheses); Flaky one; After flaky");
    expect(stdout).toContain("Retrying gamma: the whole group");
    expect(stdout).toContain("- alpha: Flaky one");
    expect(stdout).toContain("- gamma: the whole group");
    // The lines the release check's progress reader matches stay as they were.
    expect(stdout).toMatch(/^✅ alpha\s+[0-9.]+ min$/m);
    expect(stdout).toMatch(/^3 of 3 groups passed \(2 flaky journeys\) in /m);
  });

  test("groups run at most as many at once as allowed, each in a temp folder of its own that goes when it ends", () => {
    const { code, stdout, runs } = runParallel({ STAND_IN_HOLD_MS: "150" }, ["--at-once", "1"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/^Running 3 groups, at most 1 at once \([0-9.]+ GB available, about 400 MB each\): alpha, beta, gamma$/m);
    const spans = [...runs].sort((a, b) => a.start - b.start);
    for (let at = 1; at < spans.length; at++) expect(spans[at]!.start).toBeGreaterThanOrEqual(spans[at - 1]!.end);
    expect(new Set(runs.map(one => one.tmp)).size).toBe(runs.length);
    for (const one of runs) { expect(one.tmp.startsWith(tmpdir())).toBe(true); expect(existsSync(one.tmp)).toBe(false); }
  });

  test("a console error from a journey that passed is never retried away: the whole group runs again and fails", () => {
    const { code, stdout, runs } = runParallel({ STAND_IN_CONSOLE_ERROR: "1" });
    expect(code).toBe(1);
    const alpha = runs.filter(one => one.group === "alpha");
    expect(alpha[1]!.ran).toContain("Independent");
    expect(stdout).toContain("Retrying alpha: the whole group");
    expect(stdout).toMatch(/^❌ alpha\s+[0-9.]+ min$/m);
  });

  test("a journey skipped on the retry proved nothing: the group fails", () => {
    const { code, stdout } = runParallel({ STAND_IN_SKIP_ON_RETRY: "1" });
    expect(code).toBe(1);
    expect(stdout).toMatch(/^❌ alpha\s+[0-9.]+ min$/m);
    expect(stdout).not.toContain("- alpha: Flaky one");
  });

  test("a journey that fails again fails the run", () => {
    const { code, stdout, runs } = runParallel({ STAND_IN_ALWAYS_FAILS: "1" });
    expect(code).toBe(1);
    expect(runs.filter(one => one.group === "alpha")[1]!.ran).toEqual(["Setup (with a $ and parentheses)", "Flaky one", "After flaky", "No browser errors on any page"]);
    expect(stdout).toMatch(/^❌ alpha\s+[0-9.]+ min$/m);
    expect(stdout).toMatch(/^2 of 3 groups passed \(1 flaky journey\) in /m);
  });

  test("an idle machine: the groups start together, as before, and nothing waits", () => {
    const { code, stdout, runs } = runParallel({ STAND_IN_HOLD_MS: "400" });
    expect(code).toBe(0);
    expect(stdout).toMatch(/^Running 3 groups, at most 3 at once \(32\.0 GB available, about 400 MB each\): alpha, beta, gamma$/m);
    expect(overlapped(runs.filter(one => !one.out.endsWith("-retry")))).toBe(true);
    expect(stdout).not.toContain("waiting for room");
    expect(stdout).toMatch(/^admission: ran up to 3 groups at a time: lowest 32\.0 GB free, swap up to 0% used; up to 3 provider turns of ours, 0 other sessions \(cap \d+, from [0-9.]+ GB memory, default maximum 4\); nothing waited for room$/m);
  });

  test("low memory and full swap: each group and retry waits for room, one at a time, and a retry after a wait still judges flaky", () => {
    const { code, stdout, runs } = runParallel({ STAND_IN_HOLD_MS: "100" }, [], { platform: "linux", pressure: null, available: 1.5 * GB, swapUsed: 63 * GB, swapTotal: 64 * GB, providers: 1 });
    expect(code).toBe(0);
    // alpha and its retry, beta, and gamma's retry (its first run crashed before it could say).
    expect(runs).toHaveLength(4);
    expect(overlapped(runs)).toBe(false);
    expect(stdout).toMatch(/^waiting for room to start stand-in (alpha|beta|gamma): 1\.5 GB free, swap 98% used; it needs [0-9.]+ GB$/m);
    expect(stdout).toContain("- alpha: Flaky one");
    expect(stdout).toMatch(/^3 of 3 groups passed \(2 flaky journeys\) in /m);
    expect(stdout).toMatch(/^admission: ran up to 1 group at a time: lowest 1\.5 GB free, swap up to 98% used; up to 1 provider turn of ours, 1 other session \(cap \d+, from [0-9.]+ GB memory, default maximum 4\); [2-4] starts waited [0-9.]+ s in all for room \(longest: stand-in [a-z-]+, 1\.5 GB free, swap 98% used; it needs [0-9.]+ GB\)$/m);
  });

  test("the provider cap: TOOLROLL_CHECK_PROVIDERS=1 runs one group at a time with memory to spare; a larger cap runs them together", () => {
    const capped = runParallel({ STAND_IN_HOLD_MS: "150", TOOLROLL_CHECK_PROVIDERS: "1" });
    expect(capped.code).toBe(0);
    expect(overlapped(capped.runs)).toBe(false);
    expect(capped.stdout).toMatch(/^waiting for room to start stand-in [a-z-]+: 1 provider turn of ours and 0 other sessions running, at the cap of 1$/m);
    expect(capped.stdout).toMatch(/\(cap 1, from TOOLROLL_CHECK_PROVIDERS\)/);
    rmSync(dir!, { recursive: true, force: true });
    const roomy = runParallel({ STAND_IN_HOLD_MS: "400", TOOLROLL_CHECK_PROVIDERS: "3" });
    expect(overlapped(roomy.runs.filter(one => !one.out.endsWith("-retry")))).toBe(true);
    rmSync(dir!, { recursive: true, force: true });
    const bad = runParallel({ TOOLROLL_CHECK_PROVIDERS: "many" });
    expect(bad.code).toBe(2);
    expect(bad.runs).toEqual([]);
  });

  test("two runners on one gate (the release check's flows and app) share one provider cap", async () => {
    const { script, env } = prepare();
    const gate = join(dir!, "gate");
    const runner = (out: string) => new Promise<{ code: number | null; stdout: string }>(done => {
      const child = spawn(process.execPath, [resolve("scripts/e2e-parallel.mjs"), script, "--output", join(dir!, out), "--only", "Beta|Independent|Gamma|No browser"], { env: { ...env, STAND_IN_HOLD_MS: "150", TOOLROLL_CHECK_GATE: gate, TOOLROLL_CHECK_PROVIDERS: "2" } });
      let stdout = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.on("close", code => done({ code, stdout }));
    });
    const [flows, app] = await Promise.all([runner("flows"), runner("app")]);
    const runs = runsIn(dir!).sort((a, b) => a.start - b.start);
    // At no moment more than 2 groups between the two runners.
    for (const one of runs) expect(runs.filter(other => other.start <= one.start && other.end > one.start).length).toBeLessThanOrEqual(2);
    expect(runs.length).toBeGreaterThanOrEqual(6);
    expect(`${flows.stdout}${app.stdout}`).toMatch(/at the cap of 2$/m);
    // Each runner reports its own starts; the gate's leases are all let go.
    expect(flows.stdout).toMatch(/^admission: ran up to [12] groups? at a time: /m);
    expect(readdirSync(join(gate, "leases"))).toEqual([]);
    expect([flows.code, app.code]).toEqual([0, 0]);
  });

  test("a run killed outright leaves no process behind: its listed process groups stop before the retry", () => {
    const { code, stdout, runs } = runParallel({ STAND_IN_LEAVES: "1" });
    expect(stdout).toContain("[gamma");
    expect(stdout).toMatch(/stopped 1 process group it left running/);
    const retried = runs.filter(one => one.group === "gamma");
    expect(retried).toHaveLength(1);
    expect(retried[0]!.leftoverAlive).toBe(false);
    expect(code).toBe(0);
  });
});

describe("a process a journey starts", () => {
  test("runs in a process group of its own, listed while it runs, and stops whole: the program and what it started", async () => {
    const out = mkdtempSync(join(tmpdir(), "so-e2e-owned-"));
    try {
      processesIn(out);
      // A console that starts a worker of its own, which ignores SIGTERM: the group still goes, by SIGKILL.
      const child = spawnOwned("serve", process.execPath, ["-e", `require("node:child_process").spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" }); setInterval(() => {}, 1000)`], { stdio: "ignore" });
      const group = child.pid!;
      expect(JSON.parse(readFileSync(join(out, "processes.json"), "utf8"))).toEqual([{ group, label: "serve" }]);
      await until("the worker to start", () => { try { return execFileSync("pgrep", ["-g", String(group)], { encoding: "utf8" }).trim().split("\n").length === 2; } catch { return false; } }, { timeoutMs: 10_000, everyMs: 100 });
      await stopGroups([group], { graceMs: 1_000 });
      expect(groupAlive(group)).toBe(false);
      expect(JSON.parse(readFileSync(join(out, "processes.json"), "utf8"))).toEqual([]);
    } finally { rmSync(out, { recursive: true, force: true }); }
  });
});
