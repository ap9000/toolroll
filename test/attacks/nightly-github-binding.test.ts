/**
 * GitHub's nightly as release debt (docs/plans/evals-nightly.md, part A): only the project's own Nightly runs on main
 * count, and a run read while it changes never mixes attempts. Each case tries to get a run counted (or a failure
 * cleared) that must not be.
 */
import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { laneIdOf, mainHistoryOf, readGithubNightly } from "../../src/nightly-github.js";
import { recordTrustedMain } from "../../src/store.js";
import { LANE_UBUNTU, nightlyWorld, openLanes, REMOTE, T0, type FakeRun, type NightlyWorld } from "../github-nightly-fake.js";

let world: NightlyWorld | null = null;
afterEach(() => { world?.close(); world = null; });
const UBUNTU = laneIdOf(".github/workflows/ci.yml", "node 24 · ubuntu-latest");
const DAY = 24 * 60 * 60_000;
const yesterday = new Date(T0.getTime() - DAY);

describe("a run that isn't the project's own nightly on main never counts", () => {
  test.each([
    { name: "a hand-started run on a branch", over: { head_branch: "feature", event: "workflow_dispatch" } },
    { name: "a run from a fork", over: { head_repository: { full_name: "mallory/app" } } },
    { name: "a run in another repository", over: { repository: { full_name: "mallory/app" }, head_repository: { full_name: "mallory/app" } } },
    { name: "nightly.yml with an @ suffix", over: { path: ".github/workflows/nightly.yml@x.yml" } },
    { name: "a lookalike workflow file", over: { path: ".github/workflows/nightIy.yml" } },
    { name: "a lookalike workflow in another folder", over: { path: "x/.github/workflows/nightly.yml" } },
    { name: "a pull request's run", over: { event: "pull_request" } },
  ] satisfies { name: string; over: Partial<FakeRun> }[])("$name", async ({ over }) => {
    const w = (world = nightlyWorld());
    w.gh.job(w.gh.run(1, { at: yesterday, ...over }), 1, LANE_UBUNTU, "failure");
    expect(await readGithubNightly(w.store, w.repo, w.deps(), 60_000)).toMatchObject({ ok: true });
    expect(w.store.handle.prepare("SELECT COUNT(*) AS n FROM nightly_lane_job").get()?.["n"]).toBe(0);
    expect(openLanes(w.store, w.repo)).toEqual([]);
  });

  test("a lookalike job name is no lane, and a passing lookalike never clears", async () => {
    const w = (world = nightlyWorld());
    w.gh.job(w.gh.run(1, { at: new Date(T0.getTime() - 2 * DAY) }), 1, LANE_UBUNTU, "failure");
    const later = w.gh.run(2, { at: yesterday });
    for (const name of [`${LANE_UBUNTU} `, "nightly floor / node 24 · ubuntu-latest", "nightIy / node 24 · ubuntu-latest", "node 24 · ubuntu-latest"]) w.gh.job(later, 1, name, "success");
    await readGithubNightly(w.store, w.repo, w.deps(), 60_000);
    expect(openLanes(w.store, w.repo)).toEqual([UBUNTU]);
    expect(w.store.handle.prepare("SELECT COUNT(*) AS n FROM nightly_lane_job WHERE gh_run = 2").get()?.["n"]).toBe(0);
  });

  test("a head not on main's first-parent history, as the plane read main from the recorded remote", async () => {
    const w = (world = nightlyWorld());
    mkdirSync(w.repo, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", ["-C", w.repo, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "a");
    const onMain = git("rev-parse", "HEAD");
    git("checkout", "-q", "-b", "side");
    git("commit", "-q", "--allow-empty", "-m", "side");
    const side = git("rev-parse", "HEAD");
    git("checkout", "-q", "main");
    git("commit", "-q", "--allow-empty", "-m", "c");
    expect(recordTrustedMain(w.store, w.repo, git("rev-parse", "HEAD"), REMOTE, T0)).toBe(true);
    w.gh.job(w.gh.run(1, { at: yesterday, head: side }), 1, LANE_UBUNTU, "failure");
    w.gh.job(w.gh.run(2, { at: yesterday, head: onMain }), 1, "nightly / Windows Job Object containment", "failure");
    const deps = { ...w.deps(), ...mainHistoryOf(w.store, w.repo, T0) };
    await readGithubNightly(w.store, w.repo, deps, 60_000);
    expect(openLanes(w.store, w.repo)).toEqual([laneIdOf(".github/workflows/ci.yml", "Windows Job Object containment")]);
    expect(w.store.handle.prepare("SELECT gh_run FROM github_nightly_watch").all().map(row => Number(row["gh_run"]))).toEqual([2]);
  });
});

describe("a stale read of main never drops a run", () => {
  test("a run on a commit that landed after main was last read stays watched, and counts once main is read again", async () => {
    const w = (world = nightlyWorld());
    mkdirSync(w.repo, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", ["-C", w.repo, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "a");
    const before = git("rev-parse", "HEAD");
    // Main read 20 minutes ago, at `before`; then a commit lands and tonight's run (10 minutes ago) tests it.
    expect(recordTrustedMain(w.store, w.repo, before, REMOTE, new Date(T0.getTime() - 20 * 60_000))).toBe(true);
    git("commit", "-q", "--allow-empty", "-m", "landed");
    const landed = git("rev-parse", "HEAD");
    w.gh.job(w.gh.run(1, { at: new Date(T0.getTime() - 10 * 60_000), head: landed }), 1, LANE_UBUNTU, "failure");
    await readGithubNightly(w.store, w.repo, { ...w.deps(), ...mainHistoryOf(w.store, w.repo, T0) }, 60_000);
    expect(w.store.handle.prepare("SELECT gh_run FROM github_nightly_watch").all().map(row => Number(row["gh_run"]))).toEqual([1]);
    expect(openLanes(w.store, w.repo)).toEqual([]);
    expect(recordTrustedMain(w.store, w.repo, landed, REMOTE, T0)).toBe(true);
    await readGithubNightly(w.store, w.repo, { ...w.deps(), ...mainHistoryOf(w.store, w.repo, T0) }, 60_000);
    expect(openLanes(w.store, w.repo)).toEqual([UBUNTU]);
  });
});

describe("a run read while it changes", () => {
  test("the attempt changing mid-read: what was read stays, the new attempt is read whole next time", async () => {
    const w = (world = nightlyWorld());
    const run = w.gh.run(1, { at: yesterday });
    w.gh.job(run, 1, LANE_UBUNTU, "success");
    // Between the jobs read and the run read again, the run is re-run and its new attempt fails.
    let moved = false;
    w.gh.before = path => {
      if (!moved && path.endsWith("/attempts/1/jobs?per_page=100&page=1")) {
        moved = true;
        const attempt = w.gh.rerun(run);
        w.gh.job(run, attempt, LANE_UBUNTU, "failure", { minutes: 60 });
        run.status = "completed";
      }
    };
    await readGithubNightly(w.store, w.repo, w.deps(), 60_000);
    expect(w.store.handle.prepare("SELECT attempts_read, finished FROM github_nightly_watch WHERE gh_run = 1").get()).toEqual({ attempts_read: 0, finished: 0 });
    expect(openLanes(w.store, w.repo)).toEqual([]);
    await readGithubNightly(w.store, w.repo, w.deps(), 60_000);
    expect(openLanes(w.store, w.repo)).toEqual([UBUNTU]);
    expect(w.store.handle.prepare("SELECT attempts_read, finished FROM github_nightly_watch WHERE gh_run = 1").get()).toEqual({ attempts_read: 2, finished: 1 });
  });

  test.each([
    { name: "another run's job", over: { run_id: 99 } },
    { name: "another attempt's job", over: { run_attempt: 2 } },
    { name: "a job at another commit", over: { head_sha: "f".repeat(40) } },
  ])("an attempt listing $name is refused whole: its pass clears nothing", async ({ over }) => {
    const w = (world = nightlyWorld());
    w.gh.job(w.gh.run(1, { at: new Date(T0.getTime() - 2 * DAY) }), 1, LANE_UBUNTU, "failure");
    w.gh.job(w.gh.run(2, { at: yesterday }), 1, LANE_UBUNTU, "success", over);
    expect(await readGithubNightly(w.store, w.repo, w.deps(), 60_000)).toMatchObject({ ok: false });
    expect(openLanes(w.store, w.repo)).toEqual([UBUNTU]);
    expect(w.store.handle.prepare("SELECT COUNT(*) AS n FROM nightly_lane_job WHERE gh_run = 2").get()?.["n"]).toBe(0);
  });
});
