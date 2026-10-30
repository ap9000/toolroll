/**
 * GitHub's nightly as release debt (docs/plans/evals-nightly.md, part A): what the plane's read of every run and
 * attempt records, which failures open debt, and what clears it. A fake GitHub (test/github-nightly-fake.ts): no
 * network, no gh, no credentials.
 */
import { afterEach, describe, expect, test } from "vitest";
import { aliasNightlyLane, laneIdOf, laneName, readGithubNightly, retireNightlyLane } from "./nightly-github.js";
import { runReleaseCommand } from "./release-cli.js";
import { aggregateSteps, beforeTests, LANE_UBUNTU, LANE_WINDOWS, nightlyWorld, openLanes, sha, shardName, T0, type NightlyWorld } from "../test/github-nightly-fake.js";

let world: NightlyWorld | null = null;
afterEach(() => { world?.close(); world = null; });
const DAY = 24 * 60 * 60_000;
const ago = (days: number, from = T0) => new Date(from.getTime() - days * DAY);
const UBUNTU = laneIdOf(".github/workflows/ci.yml", "node 24 · ubuntu-latest");
const WINDOWS = laneIdOf(".github/workflows/ci.yml", "Windows Job Object containment");
const read = async (w: NightlyWorld, budget = 600_000) => readGithubNightly(w.store, w.repo, w.deps(), budget);
const watched = (w: NightlyWorld) => w.store.handle.prepare("SELECT gh_run FROM github_nightly_watch WHERE repo = ? ORDER BY gh_run").all(w.repo).map(row => Number(row["gh_run"]));

describe("every run and attempt is read, and nothing read later erases a failure", () => {
  test("a failure followed by a cancelled run is still open", async () => {
    const w = (world = nightlyWorld());
    w.gh.job(w.gh.run(1, { at: ago(2) }), 1, LANE_UBUNTU, "failure");
    w.gh.job(w.gh.run(2, { at: ago(1) }), 1, LANE_UBUNTU, "cancelled");
    expect(await read(w)).toMatchObject({ ok: true });
    expect(openLanes(w.store, w.repo)).toEqual([UBUNTU]);
    expect(w.store.handle.prepare("SELECT cause FROM nightly_lane_job WHERE gh_run = 2").get()?.["cause"]).toBe("not-run");
  });

  test("a failed earlier attempt with a passing later attempt is still open", async () => {
    const w = (world = nightlyWorld());
    const run = w.gh.run(1, { at: ago(1), run_attempt: 2 });
    w.gh.job(run, 1, LANE_UBUNTU, "failure");
    w.gh.job(run, 2, LANE_UBUNTU, "success", { minutes: 60 });
    await read(w);
    expect(openLanes(w.store, w.repo)).toEqual([UBUNTU]);
  });

  test("a completed failed job in a running workflow is ingested", async () => {
    const w = (world = nightlyWorld());
    const run = w.gh.run(1, { at: ago(0.1), status: "in_progress" });
    w.gh.job(run, 1, LANE_WINDOWS, "failure");
    w.gh.job(run, 1, LANE_UBUNTU, null, { status: "in_progress", completed_at: null });
    await read(w);
    expect(openLanes(w.store, w.repo)).toEqual([WINDOWS]);
    expect(w.store.handle.prepare("SELECT attempts_read, finished FROM github_nightly_watch WHERE gh_run = 1").get()).toEqual({ attempts_read: 0, finished: 0 });
  });

  test("a same-run re-run doesn't clear; the next run clears", async () => {
    const w = (world = nightlyWorld());
    const first = w.gh.run(1, { at: ago(2) });
    w.gh.job(first, 1, LANE_UBUNTU, "failure");
    await read(w);
    const attempt = w.gh.rerun(first);
    w.gh.job(first, attempt, LANE_UBUNTU, "success", { minutes: 120 });
    first.status = "completed";
    await read(w);
    expect(openLanes(w.store, w.repo)).toEqual([UBUNTU]);
    // A different, later nightly run on a commit that contains the failed one.
    w.gh.job(w.gh.run(2, { at: ago(1) }), 1, LANE_UBUNTU, "success");
    await read(w);
    expect(openLanes(w.store, w.repo)).toEqual([]);
    expect(w.store.handle.prepare("SELECT closed_why, cleared_by_job FROM nightly_lane_failure").get()).toMatchObject({ closed_why: "passed", cleared_by_job: expect.stringMatching(/^2\/1\/\d+$/) });
  });
});

describe("cause of a failure", () => {
  // Shards are named "nightly / node 24 · shard N/4"; the aggregate lane fails at one of its two checks.
  test.each([
    { name: "the coverage verifier failing with every shard green (a test file that ran in no shard)", failed: "covered" as const, shards: ["success", "success", "success", "success"], opens: true },
    { name: "every shard passed failing with zero failed shards", failed: "passed" as const, shards: ["success", "success", "success", "success"], opens: true },
    { name: "every shard passed failing with every failed shard before its tests", failed: "passed" as const, shards: ["success", "before", "success", "before"], opens: false },
    { name: "every shard passed failing with a shard that ran its tests", failed: "passed" as const, shards: ["success", "before", "ran", "success"], opens: true },
    { name: "every shard passed failing with an unreadable failed shard", failed: "passed" as const, shards: ["success", "unreadable", "success", "success"], opens: true },
  ])("$name: opens debt $opens", async ({ failed, shards, opens }) => {
    const w = (world = nightlyWorld());
    const run = w.gh.run(1, { at: ago(1) });
    shards.forEach((state, index) => w.gh.job(run, 1, shardName(index + 1), state === "success" ? "success" : "failure",
      state === "before" ? { steps: beforeTests() } : state === "unreadable" ? { steps: null } : {}));
    w.gh.job(run, 1, LANE_UBUNTU, "failure", { steps: aggregateSteps(failed) });
    await read(w);
    expect(openLanes(w.store, w.repo)).toEqual(opens ? [UBUNTU] : []);
    expect(w.store.handle.prepare("SELECT cause FROM nightly_lane_job WHERE lane_id = ?").get(UBUNTU)?.["cause"]).toBe(opens ? "test-failure" : "runner-failure");
  });

  test.each([
    { name: "an unreadable cause (no step records)", conclusion: "failure", steps: null, cause: "test-failure" },
    { name: "a timed-out lane that ran its steps", conclusion: "timed_out", steps: undefined, cause: "test-failure" },
    { name: "an unknown conclusion", conclusion: "startup_failure", steps: undefined, cause: "test-failure" },
    { name: "a lane that failed before its own steps", conclusion: "failure", steps: beforeTests(), cause: "runner-failure" },
    { name: "a skipped lane", conclusion: "skipped", steps: undefined, cause: "not-run" },
  ])("$name is $cause", async ({ conclusion, steps, cause }) => {
    const w = (world = nightlyWorld());
    w.gh.job(w.gh.run(1, { at: ago(1) }), 1, LANE_WINDOWS, conclusion, steps === undefined ? {} : { steps });
    await read(w);
    expect(w.store.handle.prepare("SELECT cause FROM nightly_lane_job").get()?.["cause"]).toBe(cause);
    expect(openLanes(w.store, w.repo)).toEqual(cause === "test-failure" ? [WINDOWS] : []);
  });
});

describe("the watch list and the paging cursor", () => {
  test("a re-run of a 20-day-old nightly that fails is ingested; one past 30 days isn't", async () => {
    const w = (world = nightlyWorld());
    const young = w.gh.run(1, { at: ago(18) }), old = w.gh.run(2, { at: ago(29) });
    w.gh.job(young, 1, LANE_UBUNTU, "success");
    w.gh.job(old, 1, LANE_UBUNTU, "success");
    await read(w);
    expect(watched(w)).toEqual([1, 2]);
    w.clock.now = new Date(T0.getTime() + 2 * DAY);
    await read(w);
    expect(watched(w)).toEqual([1]);
    for (const run of [young, old]) { const attempt = w.gh.rerun(run); w.gh.job(run, attempt, LANE_UBUNTU, "failure", { minutes: 3 * DAY / 60_000 }); run.status = "completed"; }
    await read(w);
    expect(w.store.handle.prepare("SELECT gh_run FROM nightly_lane_failure").all().map(row => Number(row["gh_run"]))).toEqual([1]);
  });

  test("a running nightly stays watched past 30 days until it finishes", async () => {
    const w = (world = nightlyWorld());
    const run = w.gh.run(1, { at: ago(29), status: "in_progress" });
    await read(w);
    w.clock.now = new Date(T0.getTime() + 5 * DAY);
    await read(w);
    expect(watched(w)).toEqual([1]);
    w.gh.job(run, 1, LANE_UBUNTU, "failure", { minutes: 33 * 24 * 60 });
    run.status = "completed";
    await read(w);
    expect(openLanes(w.store, w.repo)).toEqual([UBUNTU]);
    expect(watched(w)).toEqual([]);
  });

  test("a backlog over 10 pages is worked through across reads, never refused whole", async () => {
    const w = (world = nightlyWorld());
    // 1150 runs in the last 24 days (GitHub answers at most 1000 to one listing); the oldest failed.
    for (let id = 1; id <= 1150; id++) w.gh.run(id, { at: new Date(ago(24).getTime() + id * 30 * 60_000), head: sha(1) });
    w.gh.job(w.gh.runs.get(1)!, 1, LANE_UBUNTU, "failure");
    expect(await read(w)).toMatchObject({ ok: true, complete: false });
    expect(watched(w)).toHaveLength(1000);
    expect(openLanes(w.store, w.repo)).toEqual([]);
    expect(await read(w)).toMatchObject({ ok: true });
    expect(watched(w)).toHaveLength(1150);
    expect(openLanes(w.store, w.repo)).toEqual([UBUNTU]);
    // Caught up: the next read lists one page and stops at what it has seen.
    w.gh.calls = [];
    await read(w);
    expect(w.gh.calls.filter(path => path.includes("/workflows/nightly.yml/runs"))).toHaveLength(1);
  });

  test("the paging cursor stays before a truncated page", async () => {
    const w = (world = nightlyWorld());
    for (let id = 1; id <= 150; id++) w.gh.run(id, { at: new Date(ago(10).getTime() + id * 60_000), head: sha(1) });
    w.gh.job(w.gh.runs.get(1)!, 1, LANE_UBUNTU, "failure");
    let cut = true;
    w.gh.truncate = path => cut && path.includes("page=2");
    expect(await read(w)).toMatchObject({ ok: false, why: expect.stringContaining("cut short") });
    // Page 1 was whole and recorded; page 2 wasn't, and the cursor stays before it.
    expect(watched(w)).toHaveLength(100);
    expect(JSON.parse(String(w.store.handle.prepare("SELECT page_cursor FROM github_nightly_cursor").get()?.["page_cursor"]))).toMatchObject({ done: 0, scan: { top: 150 } });
    cut = false;
    expect(await read(w)).toMatchObject({ ok: true });
    expect(watched(w)).toHaveLength(150);
    expect(openLanes(w.store, w.repo)).toEqual([UBUNTU]);
  });
});

describe("turning it on, renaming and retiring lanes are a person's steps", () => {
  test("the CLI: a person's password turns it on; the lead's token or a wrong password never does", async () => {
    const w = (world = nightlyWorld({ optIn: false }));
    const lines: string[] = [];
    const cli = (args: string[]) => runReleaseCommand(["nightly", ...args, "--repo", w.repo, "--json"], line => lines.push(line), { database: w.databaseFile, now: () => T0 });
    expect(await cli(["--github", "--as", "alex", "--token", "wrong-password-0000"])).toBe(1);
    process.env["TOOLROLL_LEAD_TOKEN"] = "lt_x";
    try { expect(await cli(["--github", "--as", "alex", "--token", w.password])).toBe(1); } finally { delete process.env["TOOLROLL_LEAD_TOKEN"]; }
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ ok: false, reason: "person-only" });
    expect(await cli(["--github", "--lane-retire", UBUNTU, "--as", "alex", "--token", w.password])).toBe(2);
    expect(await cli(["--github", "--as", "alex", "--token", w.password])).toBe(0);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ ok: true, command: "release nightly", github: "acme/app", lanes: 9 });
  });

  test("a renamed job keeps its lane's open debt only by a person's alias; a lane a required check names can't retire", async () => {
    const w = (world = nightlyWorld());
    w.gh.job(w.gh.run(1, { at: ago(2) }), 1, LANE_WINDOWS, "failure");
    await read(w);
    // The job is renamed: without an alias the new name is no lane, and its pass clears nothing.
    w.gh.job(w.gh.run(2, { at: ago(1) }), 1, "nightly / Windows containment", "success");
    await read(w);
    expect(openLanes(w.store, w.repo)).toEqual([WINDOWS]);
    expect(aliasNightlyLane(w.store, { repo: w.repo, laneId: WINDOWS, name: "Windows containment", as: "alex", token: "wrong-password-0000" }, T0)).toMatchObject({ ok: false });
    expect(aliasNightlyLane(w.store, { repo: w.repo, laneId: WINDOWS, name: "Windows containment", as: "alex", token: w.password }, T0)).toEqual({ ok: true });
    expect(laneName(w.store, w.repo, WINDOWS)).toBe("Windows containment");
    w.gh.job(w.gh.run(3, { at: ago(0.5) }), 1, "nightly / Windows containment", "success");
    await read(w);
    expect(openLanes(w.store, w.repo)).toEqual([]);
    expect(retireNightlyLane(w.store, { repo: w.repo, laneId: WINDOWS, as: "alex", token: w.password }, T0)).toMatchObject({ ok: false, message: expect.stringContaining("still a required check") });
    // A name another live lane answers to, or a required check another lane owns, is never aliased, debt or not.
    for (const name of ["node 24 · ubuntu-latest", "git 2.47 · debian trixie", "node 24 · macos-latest"]) {
      expect(aliasNightlyLane(w.store, { repo: w.repo, laneId: WINDOWS, name, as: "alex", token: w.password }, T0), name).toMatchObject({ ok: false });
    }
    expect(w.store.handle.prepare("SELECT COUNT(*) AS n FROM nightly_lane_alias").get()?.["n"]).toBe(1);
  });
});
