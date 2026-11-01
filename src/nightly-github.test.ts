/**
 * GitHub's nightly as release debt (docs/plans/evals-nightly.md, part A): what the plane's read of every run and
 * attempt records, which failures open debt, and what clears it. A fake GitHub (test/github-nightly-fake.ts): no
 * network, no gh, no credentials.
 */
import { afterEach, describe, expect, test } from "vitest";
import { aliasNightlyLane, githubNightlyStatus, laneIdOf, laneName, nightlyBoundary, nightlyDebtHold, nightlyNeedsYou, nightlyWarning, readGithubNightly, retireNightlyLane, seedLanes, settleGithubNightly } from "./nightly-github.js";
import { releaseViewOf } from "./release-view.js";
import { addApprover } from "./scope.js";
import { releaseFixture } from "../test/release-fixture.js";
import { runReleaseCommand } from "./release-cli.js";
import { aggregateSteps, beforeTests, LANE_UBUNTU, LANE_WINDOWS, nightlyWorld, openLanes, sha, shardName, T0, type FakeRun, type NightlyWorld } from "../test/github-nightly-fake.js";

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

describe("a release candidate's exemption, read at each boundary", () => {
  const CANDIDATE = "c".repeat(40);
  /** An open ubuntu failure (yesterday's nightly, completed 10 minutes after it started). */
  async function failing() {
    const w = (world = nightlyWorld());
    w.gh.job(w.gh.run(1, { at: ago(1) }), 1, LANE_UBUNTU, "failure");
    await read(w);
    expect(openLanes(w.store, w.repo)).toEqual([UBUNTU]);
    return w;
  }
  const boundary = (w: NightlyWorld, phase: "deploy" | "merge" | "tag", budget = 20_000) =>
    nightlyBoundary(w.store, { repo: w.repo, taskId: "release-0.9.82", candidate: CANDIDATE, pr: 240, phase }, w.deps(), budget);
  const exemptions = (w: NightlyWorld) => Number(w.store.handle.prepare("SELECT COUNT(*) AS n FROM nightly_exemption").get()?.["n"]);

  test("an exemption needs the candidate's own job started after the failure completed", async () => {
    const w = await failing();
    // Started 5 minutes into the failed nightly: before its failure completed.
    w.gh.job(w.gh.prRun(500, CANDIDATE, { at: ago(1) }), 1, "node 24 · ubuntu-latest", "success", { minutes: 5 });
    expect(await boundary(w, "deploy")).toMatchObject({ ok: false, why: expect.stringContaining('GitHub\'s nightly failed "node 24 · ubuntu-latest"') });
    expect(exemptions(w)).toBe(0);
    w.gh.job(w.gh.prRun(501, CANDIDATE, { at: ago(0.5) }), 1, "node 24 · ubuntu-latest", "success");
    expect(await boundary(w, "deploy")).toEqual({ ok: true, warning: null });
    expect(exemptions(w)).toBe(1);
    // The stored check inside a reservation sees it while fresh, and not after.
    expect(nightlyDebtHold(w.store, { repo: w.repo, taskId: "release-0.9.82", candidate: CANDIDATE, phase: "merge", release: true, now: T0 })).toBeNull();
    expect(nightlyDebtHold(w.store, { repo: w.repo, taskId: "release-0.9.82", candidate: CANDIDATE, phase: "merge", release: true, now: new Date(T0.getTime() + 11 * 60_000) })).not.toBeNull();
    expect(nightlyDebtHold(w.store, { repo: w.repo, taskId: "release-0.9.82", candidate: "d".repeat(40), phase: "merge", release: true, now: T0 })).not.toBeNull();
  });

  test.each([".github/workflows/ci.yml", "scripts/ci-shards.mjs"])("a candidate that changes %s, which the lane runs, gets no exemption from a green job of that name", async path => {
    const w = await failing();
    w.gh.job(w.gh.prRun(501, CANDIDATE, { at: ago(0.5) }), 1, "node 24 · ubuntu-latest", "success");
    w.gh.blob = (file, ref) => (file === path && ref === CANDIDATE ? "e" : "a").repeat(40);
    expect(await boundary(w, "deploy")).toMatchObject({ ok: false, why: expect.stringContaining(`This release changes ${path}, which that lane runs, so its own CI can't stand in for the nightly`) });
    expect(exemptions(w)).toBe(0);
    // Unreadable is no exemption either.
    w.gh.blob = () => "a".repeat(40);
    w.gh.fail = p => p.includes("/contents/");
    expect(await boundary(w, "deploy")).toMatchObject({ ok: false });
    w.gh.fail = () => false;
    expect(await boundary(w, "deploy")).toMatchObject({ ok: true });
  });

  test.each([
    { name: "a re-run that is pending", change: (run: FakeRun, w: NightlyWorld) => { w.gh.rerun(run); } },
    { name: "a re-run that failed", change: (run: FakeRun, w: NightlyWorld) => { const attempt = w.gh.rerun(run); w.gh.job(run, attempt, "node 24 · ubuntu-latest", "failure", { minutes: 60 }); run.status = "completed"; } },
    { name: "a newer run that is pending", change: (_run: FakeRun, w: NightlyWorld) => { w.gh.prRun(502, CANDIDATE, { at: ago(0.1), status: "in_progress" }); } },
  ])("$name voids the exemption", async ({ change }) => {
    const w = await failing();
    const run = w.gh.prRun(501, CANDIDATE, { at: ago(0.5) });
    w.gh.job(run, 1, "node 24 · ubuntu-latest", "success");
    expect(await boundary(w, "deploy")).toMatchObject({ ok: true });
    change(run, w);
    expect(await boundary(w, "merge")).toMatchObject({ ok: false });
    expect(exemptions(w)).toBe(0);
  });

  test("an unreadable re-read isn't permission, whatever is stored", async () => {
    const w = await failing();
    w.gh.job(w.gh.prRun(501, CANDIDATE, { at: ago(0.5) }), 1, "node 24 · ubuntu-latest", "success");
    expect(await boundary(w, "deploy")).toMatchObject({ ok: true });
    w.gh.fail = path => path.includes("event=pull_request");
    expect(await boundary(w, "merge")).toMatchObject({ ok: false });
  });

  test("an exemption obtained before the merge stands at the tag; new debt after the merge waits there", async () => {
    const w = await failing();
    const run = w.gh.prRun(501, CANDIDATE, { at: ago(0.5) });
    w.gh.job(run, 1, "node 24 · ubuntu-latest", "success");
    w.gh.job(run, 1, "Windows Job Object containment", "success", { minutes: 30 });
    expect(await boundary(w, "merge")).toMatchObject({ ok: true });
    expect(await boundary(w, "tag")).toMatchObject({ ok: true });
    // After the merge, tonight's nightly fails Windows. The candidate's Windows job ran after that failure: at the tag
    // no exemption is made (the release proof refuses jobs finished after the merge).
    w.gh.job(w.gh.run(600, { at: ago(0.6), head: sha(2) }), 1, LANE_WINDOWS, "failure");
    expect(await boundary(w, "tag")).toMatchObject({ ok: false, why: expect.stringContaining("can't be tagged or published until that lane passes again: wait for tonight's nightly, or dispatch Nightly on main") });
  });

  test("an unreadable read warns and keeps the recorded debt", async () => {
    const w = await failing();
    w.gh.job(w.gh.prRun(501, CANDIDATE, { at: ago(0.5) }), 1, "node 24 · ubuntu-latest", "success");
    w.gh.fail = () => true;
    const answer = await boundary(w, "deploy");
    expect(answer).toMatchObject({ ok: false, warning: expect.stringMatching(/^GitHub nightly: couldn't be read \(.+\), last read 0 min ago\. Not holding the release\.$/) });
    // No recorded debt: the same warning, nothing held.
    w.store.handle.prepare("UPDATE nightly_lane_failure SET cleared_at = ?").run(T0.toISOString());
    expect(await boundary(w, "deploy")).toMatchObject({ ok: true, warning: expect.stringContaining("couldn't be read") });
  });
});

describe("what people see", () => {
  test("open debt is one Needs-you item and one notice; an exemption shows on the release card's view model", async () => {
    const w = (world = nightlyWorld());
    w.gh.job(w.gh.run(1, { at: ago(1) }), 1, LANE_UBUNTU, "failure");
    await read(w);
    await read(w);
    expect(nightlyNeedsYou(w.store, () => true)).toEqual([expect.objectContaining({ title: "Nightly checks failed: node 24 · ubuntu-latest",
      reason: `On main at ${sha(1).slice(0, 7)}. Releases wait until it passes again.`, href: expect.stringMatching(/^https:\/\/github\.com\/acme\/app\/actions\/runs\/1\/job\/\d+$/) })]);
    expect(nightlyNeedsYou(w.store, () => false)).toEqual([]);
    expect(w.store.handle.prepare("SELECT COUNT(*) AS n FROM notification WHERE kind = 'github-nightly-failed'").get()?.["n"]).toBe(1);

    const f = releaseFixture();
    try {
      seedLanes(f.store, f.repo, T0);
      const failure = Number(f.store.handle.prepare("INSERT INTO nightly_lane_failure (repo, lane_id, gh_run, run_created_at, attempt, job_id, sha, completed_at, opened_at) VALUES (?, ?, 7, '2026-10-25T00:00:00.000Z', 1, 70, ?, ?, ?)")
        .run(f.repo, UBUNTU, f.base, "2026-10-30T06:17:00.000Z", T0.toISOString()).lastInsertRowid);
      const lines = () => releaseViewOf(f.store, f.taskId, T0)!.githubNightly;
      expect(lines()).toEqual(["GitHub nightly: failed node 24 · ubuntu-latest (Oct 30, 06:17 UTC). This release waits until it passes again."]);
      f.store.handle.prepare("INSERT INTO nightly_exemption (task, candidate, failure_id, pr, gh_run, attempt, job_id, started_at, completed_at, read_at) VALUES (?, ?, ?, 240, 9, 1, 90, ?, ?, ?)")
        .run(f.taskId, f.approved, failure, T0.toISOString(), T0.toISOString(), T0.toISOString());
      expect(lines()).toEqual(["GitHub nightly: failed node 24 · ubuntu-latest (Oct 30, 06:17 UTC). This release re-ran it after the failure and passed."]);
    } finally { f.close(); }
  });
});

describe("Codex round 1", () => {
  test("finding 2: a rerun of an older run never clears newer debt; a run created later does", async () => {
    const w = (world = nightlyWorld());
    const older = w.gh.run(1, { at: ago(2), head: sha(5) });
    w.gh.job(older, 1, LANE_UBUNTU, "success");
    w.gh.job(w.gh.run(2, { at: ago(1), head: sha(5) }), 1, LANE_UBUNTU, "failure");
    await read(w);
    const attempt = w.gh.rerun(older);
    w.gh.job(older, attempt, LANE_UBUNTU, "success", { minutes: 2 * 24 * 60 });
    older.status = "completed";
    await read(w);
    expect(openLanes(w.store, w.repo)).toEqual([UBUNTU]);
    w.gh.job(w.gh.run(3, { at: ago(0.5), head: sha(6) }), 1, LANE_UBUNTU, "success");
    await read(w);
    expect(openLanes(w.store, w.repo)).toEqual([]);
  });

  test("finding 4: unfinished runs never starve a finished run whose rerun failed", async () => {
    const w = (world = nightlyWorld());
    const done = w.gh.run(1, { at: ago(3) });
    w.gh.job(done, 1, LANE_UBUNTU, "success");
    for (let id = 2; id <= 5; id++) w.gh.run(id, { at: ago(2), status: "in_progress" });
    await read(w);
    const attempt = w.gh.rerun(done);
    w.gh.job(done, attempt, LANE_UBUNTU, "failure", { minutes: 4 * 24 * 60 });
    done.status = "completed";
    // Every call takes 10 s of a 60 s budget: about six calls a read.
    w.gh.before = () => { w.clock.now = new Date(w.clock.now.getTime() + 10_000); };
    for (let poll = 0; poll < 6 && openLanes(w.store, w.repo).length === 0; poll++) await read(w, 60_000);
    expect(openLanes(w.store, w.repo)).toEqual([UBUNTU]);
  });

  test("finding 5: a run whose commit can't be placed on main is a stated unresolved read, never a fresh whole one", async () => {
    const w = (world = nightlyWorld());
    w.gh.job(w.gh.run(1, { at: ago(1), head: sha(900) }), 1, LANE_UBUNTU, "failure");
    const deps = { ...w.deps(), onMain: () => "unknown" as const };
    expect(await readGithubNightly(w.store, w.repo, deps, 60_000)).toMatchObject({ ok: true, complete: false });
    const status = githubNightlyStatus(w.store, w.repo, T0);
    expect(status).toMatchObject({ lastOkAt: null, lastWhy: expect.stringContaining("couldn't be placed on main's history yet") });
    expect(nightlyWarning(status, T0)).toContain("GitHub nightly: couldn't be read (nightly run 1's commit");
    expect(w.store.handle.prepare("SELECT gh_run FROM github_nightly_watch").all()).toHaveLength(1);
  });

  test("finding 3: a re-read that fails takes the stored exemption away from every later stored check", async () => {
    const w = (world = nightlyWorld());
    const candidate = "c".repeat(40);
    w.gh.job(w.gh.run(1, { at: ago(1) }), 1, LANE_UBUNTU, "failure");
    await read(w);
    w.gh.job(w.gh.prRun(501, candidate, { at: ago(0.5) }), 1, "node 24 · ubuntu-latest", "success");
    const boundary = () => nightlyBoundary(w.store, { repo: w.repo, taskId: "release-0.9.82", candidate, pr: 240, phase: "deploy" }, w.deps());
    const stored = () => nightlyDebtHold(w.store, { repo: w.repo, taskId: "release-0.9.82", candidate, phase: "deploy", release: true, now: T0 });
    expect(await boundary()).toMatchObject({ ok: true });
    expect(stored()).toBeNull();
    w.gh.fail = path => path.includes("event=pull_request");
    expect(await boundary()).toMatchObject({ ok: false });
    expect(stored()).not.toBeNull();
    // Read whole again, it stands again.
    w.gh.fail = () => false;
    expect(await boundary()).toMatchObject({ ok: true });
    expect(stored()).toBeNull();
  });

  test("finding 7: a person's authority is proved again inside the change, not only before it", () => {
    const w = (world = nightlyWorld());
    const robin = addApprover(w.store, "robin", T0, { name: "alex", token: w.password }, () => "fixture-password-robin-7Hd3");
    if (!robin.ok) throw new Error("robin");
    const transact = w.store.transact.bind(w.store);
    // Another process revokes alex between the password check and this change's transaction.
    w.store.transact = (<T>(body: () => T): T => { w.store.transact = transact; expect(w.store.revokeAccount("alex", "robin", T0)).toMatchObject({ ok: true }); return transact(body); }) as typeof w.store.transact;
    expect(aliasNightlyLane(w.store, { repo: w.repo, laneId: WINDOWS, name: "Windows containment", as: "alex", token: w.password }, T0)).toMatchObject({ ok: false });
    expect(w.store.handle.prepare("SELECT COUNT(*) AS n FROM nightly_lane_alias").get()?.["n"]).toBe(0);
  });

  test("finding 8: the failure notice carries its project, so a project's chats may deliver it", async () => {
    const w = (world = nightlyWorld());
    w.gh.job(w.gh.run(1, { at: ago(1) }), 1, LANE_UBUNTU, "failure");
    await read(w);
    expect(w.store.handle.prepare("SELECT provenance_scope, project, link, push_class FROM notification WHERE kind = 'github-nightly-failed'").get())
      .toEqual({ provenance_scope: "project", project: w.repo, link: "/board", push_class: "attention" });
  });
});

describe("Codex round 2", () => {
  test("finding 5: an ancestry settlement can't read is unresolved: the failure stays, the read isn't whole, the warning stays", async () => {
    const w = (world = nightlyWorld());
    w.gh.job(w.gh.run(1, { at: ago(2), head: sha(5) }), 1, LANE_UBUNTU, "failure");
    w.gh.job(w.gh.run(2, { at: ago(1), head: sha(6) }), 1, LANE_UBUNTU, "success");
    const deps = { ...w.deps(), mainContains: () => "unknown" as const };
    expect(await readGithubNightly(w.store, w.repo, deps, 60_000)).toMatchObject({ ok: true, complete: false });
    expect(openLanes(w.store, w.repo)).toEqual([UBUNTU]);
    expect(githubNightlyStatus(w.store, w.repo, T0)).toMatchObject({ lastOkAt: null, lastWhy: expect.stringContaining("couldn't be read yet") });
    // The deadline passing during settlement: incomplete, with a reason.
    expect(settleGithubNightly(w.store, w.repo, w.main, T0, Date.now() - 1)).toMatchObject({ complete: false, unresolved: expect.stringContaining("ran out of time") });
    // Read whole: it clears, and the read is whole again.
    expect(await read(w)).toMatchObject({ ok: true, complete: true });
    expect(openLanes(w.store, w.repo)).toEqual([]);
    expect(githubNightlyStatus(w.store, w.repo, T0)).toMatchObject({ lastOkAt: T0.toISOString(), lastWhy: null });
  });

  test("finding 7: a credential rotated between the password check and the change: the old password changes nothing", () => {
    const w = (world = nightlyWorld());
    const transact = w.store.transact.bind(w.store);
    w.store.transact = (<T>(body: () => T): T => { w.store.transact = transact; w.store.saveApprover("alex", "rotated-credential-hash", T0); return transact(body); }) as typeof w.store.transact;
    expect(aliasNightlyLane(w.store, { repo: w.repo, laneId: WINDOWS, name: "Windows containment", as: "alex", token: w.password }, T0)).toMatchObject({ ok: false });
    expect(w.store.handle.prepare("SELECT COUNT(*) AS n FROM nightly_lane_alias").get()?.["n"]).toBe(0);
  });
});
