/**
 * The trusted side of CI's candidate isolation (scripts/ci-candidate.mjs, docs/plans/trusted-release-reports.md H1).
 * What needs root and a hosted runner (a real second user) runs only there, as each hardened job's canary; here are the
 * rules it stands on, each with what would get around it.
 */
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { allowedEnv, CANARY_ROUTES, canaryProblems, candidateEnv, convertReport, killAll, launch, newestAttempts, processesOf } from "../scripts/ci-candidate.mjs";

const { attacks } = createRequire(import.meta.url)("../scripts/ci-candidate-probe.cjs") as { attacks: (config: Record<string, unknown>, env?: Record<string, string>, identity?: Record<string, unknown>) => { name: string; refused: boolean; detail: string }[] };
const folder = mkdtempSync(join(tmpdir(), "ci-candidate-"));
afterAll(() => rmSync(folder, { recursive: true, force: true }));
const state = { user: "so-candidate", uid: 5501, gid: 5501, checkout: folder, home: "/c/home", tmp: "/c/tmp", cache: "/c/cache", toolchain: null };

describe("what the candidate is given", () => {
  test("only the named variables pass, never a credential by any spelling", () => {
    expect(allowedEnv(["CI=true", "TOOLROLL_REQUIRE_NATIVE=linux", "TOOLROLL_TEST_LANE=a=b"])).toEqual({ CI: "true", TOOLROLL_REQUIRE_NATIVE: "linux", TOOLROLL_TEST_LANE: "a=b" });
    for (const one of ["GITHUB_TOKEN=x", "ACTIONS_RUNTIME_TOKEN=x", "PATH=/evil", "HOME=/evil", "NODE_OPTIONS=--require=/x", "CI", "ci=true", "CI\n=x"]) expect(() => allowedEnv([one]), one).toThrow();
  });
  test("its whole environment is built, never inherited: scratch home, cache and temp", () => {
    process.env["GITHUB_TOKEN_FOR_THIS_TEST"] = "secret";
    try {
      const env = candidateEnv(state, { CI: "true" });
      expect(Object.keys(env).filter(name => /GITHUB|ACTIONS|RUNNER|TOKEN/.test(name))).toEqual([]);
      expect(env).toMatchObject({ HOME: "/c/home", TMPDIR: "/c/tmp", npm_config_cache: "/c/cache", CI: "true" });
    } finally { delete process.env["GITHUB_TOKEN_FOR_THIS_TEST"]; }
  });
  test("ending a user's processes refuses unless root", () => {
    if (process.getuid?.() === 0) return;
    expect(() => killAll(state)).toThrow(/only root/);
  });
  test("a user's processes: found by either uid, a zombie has ended, and other users' are not theirs", () => {
    const listing = ["    0     0     1 Ss", " 1002  1002   40 S+", " 1002  1002   41 Z", " 1002     0   42 R", "    0  1002   43 S", "  501   501   44 S", " 10021 10021  45 S", ""].join("\n");
    expect(processesOf(listing, 1002)).toEqual([40, 42, 43]);
    expect(processesOf("  501   501   44 S\n", 1002)).toEqual([]);
  });
  test("this machine's own ps answers in the shape the listing reads", () => {
    const listing = spawnSync("ps", ["-A", "-o", "uid=", "-o", "ruid=", "-o", "pid=", "-o", "stat="], { encoding: "utf8" });
    expect(listing.status).toBe(0);
    expect(processesOf(listing.stdout, process.getuid!())).toContain(process.pid);
  });
});

describe("the report's road back", () => {
  test("a report comes back on fd 3, moved to the runner's checkout; its exit code stands; and the cleanup ran first", async () => {
    const report = join(folder, "report.json");
    const file = join(folder, "writes.cjs");
    writeFileSync(file, `require("node:fs").writeFileSync(${JSON.stringify(report)}, JSON.stringify({ testResults: [{ name: ${JSON.stringify(`${folder}/src/a.test.ts`)} }] })); process.exit(7);`);
    let settled = 0;
    const ended = await launch(state, [process.execPath, file], { env: { PATH: process.env["PATH"] ?? "" }, report, identity: {}, settle: async () => { settled++; } });
    expect(ended.code).toBe(7);
    expect(settled).toBe(1);
    expect(JSON.parse(convertReport(ended.report!.toString("utf8"), { from: folder, to: "/runner/checkout" })).testResults[0].name).toBe("/runner/checkout/src/a.test.ts");
  });
  test("the command itself gets no fd 3: only the trusted shell's last word goes down it", async () => {
    const report = join(folder, "none.json");
    const ended = await launch(state, ["/bin/sh", "-c", "echo forged >&3"], { env: { PATH: "/usr/bin:/bin" }, report, identity: {} });
    expect(ended.report!.toString("utf8")).toBe("");
    expect(ended.code).not.toBe(0);
  });
  test.each([
    ["not JSON", "garbage"],
    ["no test results", "{}"],
    ["a file outside the copy", JSON.stringify({ testResults: [{ name: "/elsewhere/a.test.ts" }] })],
    ["a sibling folder sharing the prefix", JSON.stringify({ testResults: [{ name: "/copy-evil/a.test.ts" }] })],
    ["a nameless result", JSON.stringify({ testResults: [{}] })],
  ])("%s is no report", (_, text) => { expect(() => convertReport(text, { from: "/copy", to: "/runner" })).toThrow(); });
});

describe("attempt-named artifacts", () => {
  test("each shard's newest attempt stands, as a rerun of failed jobs leaves them", () => {
    expect(newestAttempts(["shard-24-1-a1", "shard-24-1-a3", "shard-24-2-a1", "shard-24-1-a2"])).toEqual({ "shard-24-1": "shard-24-1-a3", "shard-24-2": "shard-24-2-a1" });
    expect(newestAttempts(["macos-shard-24-1-a2"])).toEqual({ "shard-24-1": "macos-shard-24-1-a2" });
    expect(newestAttempts(["shard-24-1-a9", "shard-24-1-a10"])).toEqual({ "shard-24-1": "shard-24-1-a10" });
  });
  test.each(["shard-24-1", "shard-24-1-a0", "shard-24-1-a1-evil", "evil", "shard-24-1-a1/../x"])("%s is refused, never passed over", name => {
    expect(() => newestAttempts([name])).toThrow();
  });
});

describe("the canary", () => {
  const passed = Object.fromEntries(CANARY_ROUTES.map(route => [route, { route, attacks: [{ name: "x", refused: true, detail: "EACCES" }] }]));
  const problems = (results: Record<string, unknown>, survivors: number[] = []) => canaryProblems(results, { routes: CANARY_ROUTES, survivors });
  test("passes only when every road's probe ran, was refused, and left nothing behind", () => {
    expect(problems(passed)).toEqual([]);
    expect(CANARY_ROUTES).toEqual(["plain", "tailwind-plugin", "npm-lifecycle"]);
  });
  test.each([
    ["a road that never ran", { ...passed, "tailwind-plugin": null }, /never ran/],
    ["a road that tried nothing", { ...passed, plain: { route: "plain", attacks: [] } }, /tried nothing/],
    ["one road answering for another", { ...passed, plain: passed["npm-lifecycle"] }, /answered as/],
    ["an attempt that worked", { ...passed, plain: { route: "plain", attacks: [{ name: "no sudo", refused: false, detail: "sudo ended 0" }] } }, /no sudo/],
    ["an attempt with no verdict", { ...passed, plain: { route: "plain", attacks: [{ name: "x" }] } }, /x/],
  ])("%s fails it", (_, results, words) => { expect(problems(results as Record<string, unknown>).join("\n")).toMatch(words); });
  test("a process that outlived the step fails it", () => { expect(problems(passed, [4242])).toEqual(["process 4242 outlived the candidate's step"]); });

  test("the probe, as a privileged runner would answer it, reports every escape", () => {
    const own = join(folder, "probe");
    mkdirSync(join(own, "workspace", ".git"), { recursive: true });
    writeFileSync(join(own, "harness.mjs"), "");
    writeFileSync(join(own, "state.json"), "");
    writeFileSync(join(own, "workspace", "package.json"), "{}");
    writeFileSync(join(own, "workspace", ".git", "config"), "extraheader = AUTHORIZATION: basic x");
    const uid = process.getuid?.() ?? 0;
    const config = { out: own, uid: uid + 1, gid: 1, runner: process.pid, harness: join(own, "harness.mjs"), state: join(own, "state.json"), workspace: join(own, "workspace"), temp: own };
    const found = attacks(config, { GITHUB_TOKEN: "x", PATH: "/usr/bin" }, { uid, gid: 2, groups: [2, 3] });
    const escaped = found.filter(one => !one.refused).map(one => one.name);
    expect(escaped).toEqual(expect.arrayContaining(["runs as the candidate's user", "holds no other group", "no credential in its environment", "can't change the harness", "can't change its own terms",
      "can't reach the runner's checkout", "no token in the checkout's Git config", "can't signal the runner"]));
  });
  test("a clean environment and the expected identity read as refused", () => {
    const config = { out: folder, uid: 5, gid: 6, runner: 1, harness: "/nonexistent/h", state: "/nonexistent/s", workspace: "/nonexistent/w", temp: "/nonexistent/t" };
    const found = attacks(config, { PATH: "/usr/bin", CANDIDATE_CANARY: "{}" }, { uid: 5, gid: 6, groups: [6] });
    expect(found.filter(one => ["runs as the candidate's user", "holds no other group", "no credential in its environment", "can't change the harness"].includes(one.name)).every(one => one.refused)).toBe(true);
  });
});
