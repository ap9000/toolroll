/**
 * GitHub attempts as flaky-test lanes (docs/plans/learning-loops.md, "A CI observation"): only an exact failure-then-
 * success pairing of one job per lane is a row; everything else is rejected with its reason, never guessed.
 */
import { afterEach, describe, expect, test } from "vitest";
import { ciNotPaired, observeCiRun } from "./flaky-ci.js";
import { flakyList, flakyShow } from "./flaky.js";
import type { GhRead } from "./nightly-github.js";
import { openStore, type Store } from "./store.js";

const RELEASE_NOW = new Date("2026-11-02T12:00:00.000Z");
type Fixture = { store: Store; repo: string };
const opened: Store[] = [];
afterEach(() => { for (const store of opened.splice(0)) store.close(); });
const open = (): Fixture => { const store = openStore(":memory:"); opened.push(store); return { store, repo: "/repos/shop" }; };

describe("GitHub attempts", () => {
  const SLUG = "acme/shop", SHA = "a".repeat(40), RUN = 77;
  const job = (id: number, name: string, conclusion: string | null, attempt: number, over: Record<string, unknown> = {}) => ({ id, name, status: "completed", conclusion, head_sha: SHA, run_id: RUN, run_attempt: attempt,
    started_at: "2026-11-01T00:00:00Z", completed_at: "2026-11-01T00:05:00Z", steps: [{ number: 1, name: "Set up job", status: "completed", conclusion: "success" }, { number: 2, name: "Test", status: "completed", conclusion: conclusion }], ...over });
  const fake = (attempts: Record<number, unknown[] | null>, runOver: Record<string, unknown> = {}): GhRead => async path => {
    if (path === `repos/${SLUG}/actions/runs/${RUN}`) return { ok: true, body: { id: RUN, path: ".github/workflows/ci.yml", head_sha: SHA, event: "push", status: "completed", run_attempt: 2, created_at: "2026-11-01T00:00:00Z", ...runOver } };
    const match = /attempts\/(\d+)\/jobs/.exec(path);
    const jobs = match === null ? null : attempts[Number(match[1])];
    if (jobs === null || jobs === undefined) return { ok: false, why: "unreadable" };
    return { ok: true, body: { total_count: jobs.length, jobs } };
  };
  const observe = (f: Fixture, gh: GhRead, sha: string | null = SHA) => observeCiRun(f.store, { repo: f.repo, slug: SLUG, run: RUN, sha, gh, now: RELEASE_NOW });
  const whys = (f: Fixture) => f.store.handle.prepare("SELECT why FROM ci_pairing_rejected ORDER BY why").all().map(one => String(one["why"]));

  test("attempt 1 failed and attempt 2 passed is one lane row with both jobs; a lane that passed twice is nothing", async () => {
    const f = open();
    expect(await observe(f, fake({ 1: [job(1, "unit", "failure", 1), job(2, "lint", "success", 1)], 2: [job(3, "unit", "success", 2), job(2, "lint", "success", 2)] }))).toEqual({ observed: 1, rejected: 0 });
    const rows = flakyList(f.store, f.repo, RELEASE_NOW).rows;
    expect(rows.map(one => [one.key, one.kind])).toEqual([["github:ci.yml:unit", "lane"]]);
    expect(f.store.handle.prepare("SELECT failed_job_id, passed_job_id, failed_conclusion, passed_conclusion FROM ci_flaky_observation").all()).toEqual([{ failed_job_id: 1, passed_job_id: 3, failed_conclusion: "failure", passed_conclusion: "success" }]);
    // Decided once: a second pass adds nothing and reads no attempt.
    expect(await observe(f, fake({ 1: null, 2: null }))).toEqual({ observed: 0, rejected: 0 });
    expect(flakyShow(f.store, f.repo, "github:ci.yml:unit", RELEASE_NOW)!.history[0]).toMatchObject({ kind: "github", commit: SHA.slice(0, 7) });
  });

  test.each([
    ["a duplicate lane name", { 1: [job(1, "unit", "failure", 1), job(9, "unit", "failure", 1)], 2: [job(3, "unit", "success", 2)] }, /more than one job/],
    ["an unreadable attempt", { 1: null, 2: [job(3, "unit", "success", 2)] }, /couldn't be read whole/],
    ["a job's commit differing from the run's", { 1: [job(1, "unit", "failure", 1, { head_sha: "b".repeat(40) })], 2: [job(3, "unit", "success", 2)] }, /couldn't be read whole/],
    ["a cancelled job", { 1: [job(1, "unit", "cancelled", 1)], 2: [job(3, "unit", "success", 2)] }, /not failure then success/],
    ["a skipped job", { 1: [job(1, "unit", "failure", 1)], 2: [job(3, "unit", "skipped", 2)] }, /not failure then success/],
    ["a job in one attempt only", { 1: [job(1, "unit", "failure", 1)], 2: [] }, /isn't in both attempts/],
    ["a failure before the tests", { 1: [job(1, "unit", "failure", 1, { steps: [{ number: 1, name: "Set up job", status: "completed", conclusion: "failure" }] })], 2: [job(3, "unit", "success", 2)] }, /before its tests ran/],
  ])("%s is rejected with its reason, never paired", async (_name, attempts, why) => {
    const f = open();
    const done = await observe(f, fake(attempts as Record<number, unknown[] | null>));
    expect(done.observed).toBe(0);
    expect(done.rejected).toBeGreaterThan(0);
    expect(whys(f).join("\n")).toMatch(why);
    expect(flakyList(f.store, f.repo, RELEASE_NOW).rows).toEqual([]);
    expect(ciNotPaired(f.store, [SLUG], "2000-01-01")).toBeGreaterThan(0);
  });

  test("a run whose commit isn't the one recorded is rejected; a first attempt is nothing", async () => {
    const f = open();
    expect(await observe(f, fake({ 1: [], 2: [] }), "c".repeat(40))).toEqual({ observed: 0, rejected: 1 });
    expect(whys(f)).toEqual(["the run's commit isn't the one recorded"]);
    const g = open();
    expect(await observe(g, fake({ 1: [] }, { run_attempt: 1 }))).toEqual({ observed: 0, rejected: 0 });
  });
});
