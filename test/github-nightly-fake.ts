/**
 * A stand-in for GitHub's Actions API as the plane's gh reads it for GitHub's nightly (src/nightly-github.ts): runs of
 * nightly.yml listed newest first with GitHub's paging and its 1000-run cap, each run by id, and each exact attempt's
 * jobs with their steps. No network, no gh, no credentials. Shared by src/nightly-github.test.ts and the attack suite.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../src/store.js";
import { addApprover } from "../src/scope.js";
import { optInGithubNightly, type GhRead, type MainHistory, type NightlyDeps } from "../src/nightly-github.js";

export const SLUG = "acme/app";
export const REMOTE = "https://github.com/acme/app.git";
export const PASSWORD = "fixture-password-alex-8Kq2";
export const T0 = new Date("2026-10-30T12:00:00.000Z");
export const sha = (n: number): string => n.toString(16).padStart(40, "0");

type Step = { number: number; name: string; status: string; conclusion: string | null };
export type FakeJob = { id: number; name: string; status: string; conclusion: string | null; started_at: string | null; completed_at: string | null; head_sha: string; run_id: number; run_attempt: number; steps: Step[] | null };
export type FakeRun = { id: number; path: string; head_branch: string; head_sha: string; event: string; status: string; run_attempt: number; created_at: string;
  repository: { full_name: string }; head_repository: { full_name: string }; attempts: FakeJob[][] };

let nextJob = 1000;
/** Steps of a job that ran its own steps and failed at `failedAt` (default a test step). */
export const ranAndFailed = (failedAt = "Run the tests"): Step[] => [
  { number: 1, name: "Set up job", status: "completed", conclusion: "success" },
  { number: 2, name: failedAt, status: "completed", conclusion: "failure" },
  { number: 3, name: "Complete job", status: "completed", conclusion: "success" },
];
/** Steps of a job that ended before any of its own steps ran (the runner's failure). */
export const beforeTests = (): Step[] => [{ number: 1, name: "Set up job", status: "completed", conclusion: "failure" }];
/** An aggregate lane's steps: which of its two checks failed. */
export const aggregateSteps = (failed: "passed" | "covered"): Step[] => [
  { number: 1, name: "Set up job", status: "completed", conclusion: "success" },
  { number: 2, name: "Tested commit", status: "completed", conclusion: "success" },
  { number: 3, name: "Every shard passed", status: "completed", conclusion: failed === "passed" ? "failure" : "success" },
  { number: 4, name: "Every shard ran the whole suite", status: "completed", conclusion: failed === "covered" ? "failure" : failed === "passed" ? "skipped" : "success" },
  { number: 5, name: "Complete job", status: "completed", conclusion: "success" },
];

export class FakeGithub {
  runs = new Map<number, FakeRun>();
  calls: string[] = [];
  /** Answer a path with a failure instead (true), or change the world just before answering. */
  fail: (path: string) => boolean = () => false;
  before: (path: string) => void = () => {};
  /** Cut the next listing page short by one run. */
  truncate: (path: string) => boolean = () => false;

  run(id: number, over: Partial<Omit<FakeRun, "attempts">> & { at?: Date; head?: string } = {}): FakeRun {
    const { at, head, ...rest } = over;
    const made: FakeRun = { id, path: ".github/workflows/nightly.yml", head_branch: "main", head_sha: head ?? sha(id), event: "schedule", status: "completed", run_attempt: 1,
      created_at: (at ?? T0).toISOString(), repository: { full_name: SLUG }, head_repository: { full_name: SLUG }, attempts: [[]], ...rest };
    this.runs.set(id, made);
    return made;
  }
  /** A job in `run`'s attempt (1-based), completed unless said otherwise. */
  job(run: FakeRun, attempt: number, name: string, conclusion: string | null, over: Partial<FakeJob> & { minutes?: number } = {}): FakeJob {
    const { minutes = 0, ...rest } = over;
    const start = new Date(Date.parse(run.created_at) + minutes * 60_000);
    const job: FakeJob = { id: nextJob++, name, status: "completed", conclusion, started_at: start.toISOString(), completed_at: new Date(start.getTime() + 10 * 60_000).toISOString(),
      head_sha: run.head_sha, run_id: run.id, run_attempt: attempt, steps: conclusion === "success" ? [{ number: 1, name: "Set up job", status: "completed", conclusion: "success" }] : ranAndFailed(), ...rest };
    while (run.attempts.length < attempt) run.attempts.push([]);
    run.attempts[attempt - 1]!.push(job);
    return job;
  }
  /** A re-run: the run's next attempt starts (in progress until finished). */
  rerun(run: FakeRun): number {
    run.run_attempt += 1;
    run.status = "in_progress";
    run.attempts.push([]);
    return run.run_attempt;
  }

  read: GhRead = async path => {
    this.calls.push(path);
    this.before(path);
    if (this.fail(path)) return { ok: false, why: "HTTP 502: Bad Gateway" };
    const url = new URL(`https://api.github.com/${path}`);
    const query = url.searchParams;
    const parts = url.pathname.split("/").filter(Boolean);
    const rawRun = (one: FakeRun) => { const { attempts: _attempts, ...rest } = one; return rest; };
    if (parts.slice(0, 3).join("/") !== `repos/${SLUG}`) return { ok: false, why: "HTTP 404: Not Found" };
    if (parts[3] === "actions" && parts[4] === "workflows" && parts[5] === "nightly.yml" && parts[6] === "runs") {
      const created = query.get("created");
      const below = created === null ? null : created.replace(/^<=/, "");
      const all = [...this.runs.values()].filter(one => below === null || one.created_at <= below).sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
      const capped = all.slice(0, 1000);
      const page = Number(query.get("page") ?? "1"), per = Number(query.get("per_page") ?? "30");
      let rows = capped.slice((page - 1) * per, page * per).map(rawRun);
      if (this.truncate(path)) rows = rows.slice(0, -1);
      return { ok: true, body: { total_count: all.length, workflow_runs: rows } };
    }
    if (parts[3] === "actions" && parts[4] === "runs") {
      const one = this.runs.get(Number(parts[5]));
      if (one === undefined) return { ok: false, why: "HTTP 404: Not Found" };
      if (parts.length === 6) return { ok: true, body: rawRun(one) };
      if (parts[6] === "attempts" && parts[8] === "jobs") {
        const jobs = one.attempts[Number(parts[7]) - 1] ?? [];
        const page = Number(query.get("page") ?? "1"), per = Number(query.get("per_page") ?? "30");
        return { ok: true, body: { total_count: jobs.length, jobs: jobs.slice((page - 1) * per, page * per) } };
      }
    }
    return { ok: false, why: "HTTP 404: Not Found" };
  };
}

/** Main as a list of commits, oldest first: a commit is on main when listed; a later one contains an earlier one. */
export function mainLine(commits: string[]): MainHistory & { commits: string[] } {
  return {
    commits,
    onMain: one => commits.includes(one) ? "yes" : "no",
    mainContains: (one, ancestor) => commits.indexOf(one) >= 0 && commits.indexOf(ancestor) >= 0 && commits.indexOf(one) >= commits.indexOf(ancestor),
  };
}

export type NightlyWorld = { store: Store; repo: string; databaseFile: string; gh: FakeGithub; main: ReturnType<typeof mainLine>; clock: { now: Date }; deps: () => NightlyDeps; password: string; close(): void };

/** A plane with one project on GitHub, alex an approver, GitHub's nightly turned on, and main's history as listed. */
export function nightlyWorld(options: { main?: string[]; optIn?: boolean } = {}): NightlyWorld {
  const dir = mkdtempSync(join(tmpdir(), "so-gh-nightly-"));
  const databaseFile = join(dir, "orders.db");
  const store = openStore(databaseFile);
  const repo = join(dir, "project");
  store.upsertProject(repo, "project", T0, { remoteUrl: REMOTE });
  const added = addApprover(store, "alex", T0, undefined, () => PASSWORD);
  if (!added.ok) throw new Error("approver");
  if (options.optIn !== false) {
    const on = optInGithubNightly(store, { repo, as: "alex", token: added.token }, T0);
    if (!on.ok) throw new Error(on.message);
  }
  const gh = new FakeGithub();
  const main = mainLine(options.main ?? Array.from({ length: 200 }, (_, n) => sha(n + 1)));
  const clock = { now: T0 };
  return {
    store, repo, databaseFile, gh, main, clock, password: added.token,
    deps: () => ({ gh: gh.read, now: () => clock.now, onMain: main.onMain, mainContains: main.mainContains }),
    close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

export const LANE_UBUNTU = "nightly / node 24 · ubuntu-latest";
export const LANE_MACOS = "nightly / node 24 · macos-latest";
export const LANE_WINDOWS = "nightly / Windows Job Object containment";
export const shardName = (n: number) => `nightly / node 24 · shard ${n}/4`;
export const openLanes = (store: Store, repo: string): string[] =>
  store.handle.prepare("SELECT lane_id FROM nightly_lane_failure WHERE repo = ? AND cleared_at IS NULL ORDER BY id").all(repo).map(row => String(row["lane_id"]));
