import { describe, test, expect } from "vitest";
import { readRemote, DEFAULT_BUDGET_MS } from "./remote.js";
import type { Runner } from "./backend.js";

const OK = { code: 0, stdout: "[]", stderr: "", timedOut: false, notFound: false };

const repos = (...paths: string[]) => paths.map(path => ({ path, remoteUrl: "git@github.com:o/r" }));

/** A clock the test drives, so a budget can be spent without waiting for one. */
function fakeClock(start = 0) {
  let value = start;
  return { now: () => value, advance: (ms: number) => (value += ms) };
}

describe("readRemote", () => {
  test("reads pull requests and issues for each repository", async () => {
    const runner: Runner = async (_file, args) =>
      args[0] === "pr"
        ? { ...OK, stdout: JSON.stringify([{ number: 1, title: "t", headRefName: "b" }]) }
        : { ...OK, stdout: JSON.stringify([{ number: 9, title: "i", state: "OPEN" }]) };

    const state = await readRemote(repos("/a"), { runner });

    expect(state.get("/a")?.pulls).toHaveLength(1);
    expect(state.get("/a")?.issues).toHaveLength(1);
    expect(state.get("/a")).toMatchObject({ pullsRead: true, issuesRead: true, skipped: false });
  });

  test("never asks about a repository with no remote", async () => {
    // A local-only repo has no pull requests by definition, and spending part
    // of a shared budget to be told so comes out of the repos that do.
    let asked = false;
    const runner: Runner = async () => {
      asked = true;
      return { ...OK };
    };

    const state = await readRemote([{ path: "/local", remoteUrl: null }], { runner });

    expect(asked).toBe(false);
    expect(state.get("/local")?.skipped).toBe(false);
  });

  test("does not turn a failed issue read into an empty tracker", async () => {
    // The distinction the whole report rests on. An expired token and a repo
    // with nothing open both produce `issues: []`; only one of them is news.
    const runner: Runner = async (_file, args) =>
      args[0] === "pr"
        ? { ...OK, stdout: "[]" }
        : { ...OK, code: 1, stderr: "gh auth login required" };

    const state = await readRemote(repos("/a"), { runner });

    expect(state.get("/a")?.issues).toEqual([]);
    expect(state.get("/a")?.issuesRead).toBe(false);
    expect(state.get("/a")?.problems.join(" ")).toContain("auth login required");
  });

  test("keeps reading after one repository throws", async () => {
    // A runner that throws rather than returning a failure must not end a
    // report covering everything else.
    const runner: Runner = async (_file, _args, options) => {
      if (options?.cwd === "/bad") throw new Error("the socket exploded");
      return { ...OK };
    };

    const state = await readRemote(repos("/bad", "/good"), { runner, concurrency: 1 });

    expect(state.get("/bad")?.problems.join(" ")).toContain("socket exploded");
    expect(state.get("/good")?.pullsRead).toBe(true);
  });

  test("marks every repository the budget did not reach", async () => {
    // Each repository costs two calls — pull requests and issues — so 3s a
    // call is 6s a repository against a 10s budget: two fit, the third does not.
    const clock = fakeClock();
    const runner: Runner = async () => {
      clock.advance(3_000);
      return { ...OK };
    };

    const state = await readRemote(repos("/a", "/b", "/c"), {
      runner,
      concurrency: 1,
      budgetMs: 10_000,
      now: clock.now,
    });

    expect(state.get("/a")?.skipped).toBe(false);
    expect(state.get("/b")?.skipped).toBe(false);
    expect(state.get("/c")?.skipped).toBe(true);
  });

  test("clamps each call to what is left of the budget", async () => {
    // A deadline checked only before starting is not a bound: six lanes begun
    // a moment before it expires each run a full call timeout past it. What
    // stops that is handing every call the time that actually remains.
    const clock = fakeClock();
    const seen: number[] = [];
    const runner: Runner = async (_file, _args, options) => {
      seen.push(options?.timeoutMs ?? 0);
      clock.advance(4_500);
      return { ...OK };
    };

    await readRemote(repos("/a", "/b"), {
      runner,
      concurrency: 1,
      budgetMs: 10_000,
      now: clock.now,
    });

    // The first repository gets the whole budget; the second gets only the
    // second that is left, rather than a fresh twenty-second call timeout.
    expect(seen[0]).toBe(10_000);
    expect(seen[seen.length - 1]).toBe(1_000);
  });

  test("has a budget that is actually the default when none is given", async () => {
    const clock = fakeClock();
    const seen: number[] = [];
    const runner: Runner = async (_file, _args, options) => {
      seen.push(options?.timeoutMs ?? 0);
      return { ...OK };
    };

    await readRemote(repos("/a"), { runner, now: clock.now });

    expect(seen[0]).toBe(DEFAULT_BUDGET_MS);
  });
});
