import { describe, expect, test } from "vitest";
import { readOnlyCall, retryCall, retryingExec, transientFailure, writeWithRecheck, NET_RETRY_BUDGET_MS, type ExecResult } from "./release-net.js";
import { readMainProtection, readUpToDateRequired, releaseAdapters, ProtectionUnreadable, type Exec, type ReleaseRepo, type ReleaseTools } from "./release-adapters.js";
import { PROTECTION_MINIMUM_CHECKS } from "./release.js";

const SHA = "a".repeat(40), MERGE = "b".repeat(40);
const REPO: ReleaseRepo = { checkout: "/rv", gitDir: "/rv/.git", remote: "https://github.com/ap9000/toolroll.git", slug: "ap9000/toolroll", ssh: false };
const TOOLS: ReleaseTools = { git: "/usr/bin/git", gh: "/opt/homebrew/bin/gh", ssh: "/usr/bin/ssh" };
const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string, code = 1): ExecResult => ({ code, stdout: "", stderr });

/** A clock that moves only when the retry sleeps, and a record of every pause and line said. */
function world() {
  let at = Date.parse("2026-10-29T12:00:00Z");
  const slept: number[] = [], said: string[] = [];
  return { slept, said, options: { say: (line: string) => { said.push(line); }, sleep: async (ms: number) => { slept.push(ms); at += ms; }, now: () => new Date(at) } };
}

/** The failures seen today, and the others each class covers. */
const TRANSIENT: [string, ExecResult][] = [
  ["gh can't connect", fail("error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com")],
  ["git can't resolve github.com", fail("fatal: unable to access 'https://github.com/ap9000/toolroll.git/': Could not resolve host: github.com", 128)],
  ["gh's answer was cut short", fail("unexpected end of JSON input")],
  ["a receive timeout", fail("fatal: unable to access '…': Recv failure: Operation timed out", 128)],
  ["a connection reset", fail("read tcp 10.0.0.2:5555->140.82.112.6:443: read: connection reset by peer")],
  ["connection refused", fail("dial tcp 140.82.112.6:443: connect: Connection refused")],
  ["a 502", fail("gh: Server Error (HTTP 502)")],
  ["a 503", fail("HTTP 503: Service Unavailable (https://api.github.com/repos/ap9000/toolroll/actions/runs)")],
  ["the secondary rate limit", fail("gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)")],
  ["the coordinator's own time limit", fail("", 124)],
];
const DEFINITIVE: [string, ExecResult][] = [
  ["404", fail("gh: Not Found (HTTP 404)")],
  ["403", fail("gh: Resource not accessible by integration (HTTP 403)")],
  ["401", fail("gh: Bad credentials (HTTP 401)")],
  ["not protected", fail("gh: Branch not protected (HTTP 404)")],
  ["git auth", fail("remote: Repository not found.\nfatal: repository 'https://github.com/x/y.git/' not found", 128)],
  ["a missing program", fail("", 127)],
  ["an unknown failure", fail("something nobody has seen before")],
];

describe("release network retries: classification", () => {
  test.each(TRANSIENT)("%s is transient", (_name, result) => {
    expect(transientFailure(`${result.stderr}\n${result.stdout}`, result.code)).not.toBeNull();
  });
  test.each(DEFINITIVE)("%s is definitive (never asked again)", (_name, result) => {
    expect(transientFailure(`${result.stderr}\n${result.stdout}`, result.code)).toBeNull();
  });
  test("a secondary rate limit's Retry-After is honoured", () => {
    expect(transientFailure("HTTP 429: Too Many Requests\nRetry-After: 45")?.retryAfterMs).toBe(45_000);
  });

  test("only provable reads are retried: writes and unknown calls never are", () => {
    expect(readOnlyCall("/opt/homebrew/bin/gh", ["api", "--hostname", "github.com", "repos/a/b/commits/x/check-runs", "--jq", "."])).toMatchObject({ kind: "gh-api", jsonBody: false });
    expect(readOnlyCall("/opt/homebrew/bin/gh", ["api", "repos/a/b/branches/main/protection"])).toMatchObject({ kind: "gh-api", jsonBody: true });
    expect(readOnlyCall("/opt/homebrew/bin/gh", ["api", "-X", "GET", "repos/a/b"])).not.toBeNull();
    for (const args of [["api", "-X", "PUT", "repos/a/b/pulls/1/merge"], ["api", "--method", "POST", "repos/a/b/git/refs"], ["api", "--method=PATCH", "x"], ["api", "-XDELETE", "x"],
      ["api", "repos/a/b/git/refs", "-f", "ref=refs/tags/v1"], ["api", "x", "-F", "force=true"], ["api", "x", "--input", "body.json"], ["api", "x", "--raw-field=a=b"],
      ["pr", "create", "--repo", "a/b"], ["pr", "merge", "1"], ["release", "create", "v1"], ["auth", "status"]]) {
      expect(readOnlyCall("/opt/homebrew/bin/gh", args), args.join(" ")).toBeNull();
    }
    expect(readOnlyCall("/usr/bin/git", ["--git-dir=/rv/.git", "-c", "core.hooksPath=/dev/null", "ls-remote", "toolroll-release", "refs/heads/x"])).toMatchObject({ kind: "git" });
    expect(readOnlyCall("/usr/bin/git", ["-c", "fetch.recurseSubmodules=false", "fetch", "--quiet", "toolroll-release"])).toMatchObject({ kind: "git" });
    // A -c value that names a subcommand is skipped as a value, not read as the subcommand.
    expect(readOnlyCall("/usr/bin/git", ["-c", "ls-remote", "push", "toolroll-release", ":refs/heads/x"])).toBeNull();
    expect(readOnlyCall("/usr/bin/git", ["push", "--no-verify", "toolroll-release", ":refs/heads/x"])).toBeNull();
    expect(readOnlyCall("/usr/bin/git", ["merge", "--ff-only", "origin/main"])).toBeNull();
    expect(readOnlyCall("toolroll", ["task", "show"])).toBeNull();
  });
});

describe("release network retries: reads", () => {
  test.each(TRANSIENT)("a read that fails with %s a few times, then answers, answers", async (_name, failure) => {
    const w = world();
    let calls = 0;
    const run: Exec = async () => ++calls <= 3 ? failure : ok("{\"ok\":true}\n");
    const result = await retryingExec(run, w.options)("/opt/homebrew/bin/gh", ["api", "repos/ap9000/toolroll/actions/runs?head_sha=x", "--jq", "."]);
    expect(result).toEqual(ok("{\"ok\":true}\n"));
    expect(calls).toBe(4);
    expect(w.slept).toHaveLength(3);
    // Why it's asking again is said once per call, not once per attempt.
    expect(w.said).toHaveLength(1);
    expect(w.said[0]).toMatch(/GitHub didn't answer gh api repos\/ap9000\/toolroll\/actions\/runs .*asking again for up to 3 min/);
  });

  test("git ls-remote that can't resolve github.com twice is asked again", async () => {
    const w = world();
    let calls = 0;
    const run: Exec = async () => ++calls <= 2 ? TRANSIENT[1]![1] : ok(`${SHA}\trefs/heads/x\n`);
    expect((await retryingExec(run, w.options)("/usr/bin/git", ["-c", "x=y", "ls-remote", "toolroll-release", "refs/heads/x"])).stdout).toContain(SHA);
    expect(w.said[0]).toMatch(/git ls-remote \(Could not resolve host/);
  });

  test("a plain JSON body cut short (exit 0) is asked again; one that never parses fails, never reads as an answer", async () => {
    const w = world();
    let calls = 0;
    const run: Exec = async () => ++calls === 1 ? ok("{\"required_status_checks\":") : ok("{}");
    expect(await retryingExec(run, w.options)("/opt/homebrew/bin/gh", ["api", "repos/a/b/branches/main/protection"])).toEqual(ok("{}"));
    const never: Exec = async () => ok("{\"cut");
    const last = await retryingExec(never, world().options)("/opt/homebrew/bin/gh", ["api", "repos/a/b/branches/main/protection"]);
    expect(last.code).not.toBe(0);
    expect(last.stderr).toMatch(/cut short/);
  });

  test("a read that never succeeds stops within the budget with the ORIGINAL error", async () => {
    const w = world();
    let calls = 0;
    const run: Exec = async () => (++calls === 1 ? fail("error connecting to api.github.com") : fail("gh: Server Error (HTTP 502)"));
    const result = await retryingExec(run, w.options)("/opt/homebrew/bin/gh", ["api", "repos/a/b/check-runs", "--jq", "."]);
    expect(result).toEqual(fail("error connecting to api.github.com"));
    expect(w.slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(NET_RETRY_BUDGET_MS);
    expect(calls).toBeGreaterThan(3);
    expect(w.said).toHaveLength(1);
  });

  test("a fixed clock still ends: the attempts are capped", async () => {
    let calls = 0;
    const run: Exec = async () => { calls++; return fail("Could not resolve host: github.com", 128); };
    const fixed = { say: () => {}, sleep: async () => {}, now: () => new Date(0) };
    expect((await retryingExec(run, fixed)("/usr/bin/git", ["fetch", "toolroll-release"])).code).toBe(128);
    expect(calls).toBeLessThanOrEqual(12);
  });

  test.each(DEFINITIVE)("a definitive %s is answered at once, never asked again", async (_name, failure) => {
    const w = world();
    let calls = 0;
    const run: Exec = async () => { calls++; return failure; };
    expect(await retryingExec(run, w.options)("/opt/homebrew/bin/gh", ["api", "repos/a/b/git/ref/tags/v1"])).toEqual(failure);
    expect(calls).toBe(1);
    expect(w.slept).toEqual([]);
    expect(w.said).toEqual([]);
  });

  test("a mutating call is passed straight through: a transient failure is never retried blindly", async () => {
    for (const [command, args] of [["/opt/homebrew/bin/gh", ["api", "-X", "PUT", "repos/a/b/pulls/1/merge", "-f", `sha=${SHA}`]], ["/opt/homebrew/bin/gh", ["pr", "create", "--repo", "a/b"]],
      ["/usr/bin/git", ["push", "--no-verify", "toolroll-release", ":refs/heads/x"]]] as const) {
      const w = world();
      let calls = 0;
      const run: Exec = async () => { calls++; return fail("error connecting to api.github.com"); };
      expect((await retryingExec(run, w.options)(command, args)).code).toBe(1);
      expect(calls, args.join(" ")).toBe(1);
      expect(w.slept).toEqual([]);
    }
  });
});

describe("release network retries: writes learn whether they happened first", () => {
  /** A fake GitHub for one pull request: its merge may fail transiently, and may have happened anyway. */
  function mergeWorld(o: { failures: number; happens: "before-answer" | "never" | "other"; pullUnreadable?: boolean }) {
    let merges = 0, merged = false;
    const calls: string[] = [];
    const run: Exec = async (_command, args) => {
      const path = args.find(one => one.startsWith("repos/")) ?? "";
      if (args.includes("PUT")) {
        calls.push("merge");
        merges++;
        if (merges <= o.failures) { if (o.happens === "before-answer") merged = true; return fail("error connecting to api.github.com"); }
        merged = true;
        return ok(JSON.stringify({ sha: MERGE, merged: true }));
      }
      if (/pulls\/\d+$/.test(path)) {
        calls.push("read");
        if (o.pullUnreadable === true) return fail("error connecting to api.github.com");
        if (o.happens === "other") return ok(JSON.stringify({ state: "closed", merged: false, head: { sha: SHA } }));
        return ok(JSON.stringify({ state: merged ? "closed" : "open", merged, head: { sha: SHA }, base: { ref: "main" }, merge_commit_sha: merged ? MERGE : null }));
      }
      if (path.includes("/git/commits/")) return ok(JSON.stringify({ tree: { sha: SHA }, parents: [{ sha: SHA }] }));
      throw new Error(`unexpected ${args.join(" ")}`);
    };
    return { run, calls };
  }
  const adapters = (run: Exec, w = world()) => releaseAdapters({ checkout: "/rv", releaseRepo: REPO, tools: TOOLS, database: "/nonexistent/toolroll.db", run, ...w.options });

  test("a merge whose answer was lost, but which happened, is read back, never sent twice", async () => {
    const { run, calls } = mergeWorld({ failures: 1, happens: "before-answer" });
    expect(await adapters(run).github.merge("ap9000/toolroll", 7, SHA)).toBe(MERGE);
    expect(calls).toEqual(["merge", "read"]);
  });

  test("an open PR requires a fresh coordinator pass before another merge", async () => {
    const { run, calls } = mergeWorld({ failures: 2, happens: "never" });
    await expect(adapters(run).github.merge("ap9000/toolroll", 7, SHA)).rejects.toThrow(/error connecting/);
    expect(calls).toEqual(["merge", "read"]);
  });

  test("a merge whose pull request moved on, or whose state can't be read, stops with the original error", async () => {
    const other = mergeWorld({ failures: 1, happens: "other" });
    await expect(adapters(other.run).github.merge("ap9000/toolroll", 7, SHA)).rejects.toThrow(/gh api pulls merge failed \(exit 1\): error connecting to api\.github\.com.*no longer open/);
    expect(other.calls.filter(one => one === "merge")).toHaveLength(1);
    const blind = mergeWorld({ failures: 1, happens: "never", pullUnreadable: true });
    await expect(adapters(blind.run).github.merge("ap9000/toolroll", 7, SHA)).rejects.toThrow(/error connecting to api\.github\.com.*whether it happened couldn't be read/);
    expect(blind.calls.filter(one => one === "merge")).toHaveLength(1);
  });

  test("a definitive merge refusal is never retried or read back", async () => {
    let calls = 0;
    const run: Exec = async () => { calls++; return fail("gh: Head branch was modified. Review and try the merge again. (HTTP 409)"); };
    await expect(adapters(run).github.merge("ap9000/toolroll", 7, SHA)).rejects.toThrow(/Head branch was modified/);
    expect(calls).toBe(1);
  });

  test("a tag whose creation answer was lost is read back: there at the commit is done, missing is asked again", async () => {
    let tagged: string | null = null, posts = 0;
    const run: Exec = async (_command, args) => {
      if (args.includes("POST")) { posts++; if (posts === 1) { tagged = MERGE; return fail("Recv failure: Operation timed out"); } return ok("{}"); }
      return tagged === null ? fail("gh: Not Found (HTTP 404)") : ok(JSON.stringify({ object: { type: "commit", sha: tagged } }));
    };
    await adapters(run).github.createTag("ap9000/toolroll", "v1.0.0", MERGE);
    expect(posts).toBe(1);
    // Never written: asked again after reading that it isn't there.
    let second = 0;
    const missing: Exec = async (_command, args) => args.includes("POST") ? (++second === 1 ? fail("error connecting to api.github.com") : ok("{}")) : fail("gh: Not Found (HTTP 404)");
    await adapters(missing).github.createTag("ap9000/toolroll", "v1.0.0", MERGE);
    expect(second).toBe(2);
  });

  test("the release's git: ls-remote is asked again with the checkout's config re-read before every attempt; a push never is", async () => {
    const calls: string[] = [];
    let looks = 0;
    const run: Exec = async (_command, args) => {
      if (args.includes("config")) { calls.push("config"); return ok(""); }
      if (args.includes("ls-remote")) { calls.push("ls-remote"); return ++looks <= 2 ? fail("fatal: unable to access '…': Could not resolve host: github.com", 128) : ok(`${SHA}\trefs/heads/x\n`); }
      if (args.includes("push")) { calls.push("push"); return fail("fatal: unable to access '…': Could not resolve host: github.com", 128); }
      throw new Error(`unexpected ${args.join(" ")}`);
    };
    const w = world();
    expect(await adapters(run, w).repo.remoteHead("x")).toBe(SHA);
    expect(calls).toEqual(["config", "ls-remote", "config", "ls-remote", "config", "ls-remote"]);
    expect(w.said).toEqual([expect.stringMatching(/git ls-remote \(Could not resolve host: github\.com\)/)]);
    // deleteBranch: the push fails once and is never pushed again; it re-reads (ls-remote) and stops when the branch is still there.
    calls.length = 0; looks = 2;
    await expect(adapters(run).repo.deleteBranch("x", SHA)).rejects.toThrow(/deleting merged branch x failed/);
    expect(calls.filter(one => one === "push")).toHaveLength(1);
  });

  test("writeWithRecheck answers the first error when the budget runs out", async () => {
    const w = world();
    let writes = 0;
    await expect(writeWithRecheck("x", w.options, {
      write: async () => { writes++; return fail(writes === 1 ? "error connecting to api.github.com" : "HTTP 502"); },
      accept: () => 1, refuse: result => { throw new Error(result.stderr); }, recheck: async () => ({ state: "not-done" }),
    })).rejects.toThrow(/^error connecting to api\.github\.com$/);
    expect(writes).toBeGreaterThan(1);
  });
});

describe("main's protection: couldn't read is never doesn't hold", () => {
  const live = { required_status_checks: { strict: true, contexts: [...PROTECTION_MINIMUM_CHECKS], checks: PROTECTION_MINIMUM_CHECKS.map(context => ({ context, app_id: 15368 })) }, enforce_admins: { enabled: true } };
  const gh = (classic: () => ExecResult, rules: () => ExecResult = () => ok("")): Exec => async (_command, args) => {
    const path = args.find(one => one.startsWith("repos/")) ?? "";
    return path.endsWith("/protection") ? classic() : rules();
  };

  test("a transient classic read is retried, then judged: holds", async () => {
    const w = world();
    let calls = 0;
    const exec = retryingExec(gh(() => ++calls <= 2 ? fail("error connecting to api.github.com") : ok(JSON.stringify(live))), w.options);
    expect(await readMainProtection(exec, "/opt/homebrew/bin/gh", "ap9000/toolroll")).toMatchObject({ effective: true });
    expect(calls).toBe(3);
  });

  test("a classic read that never answers throws 'couldn't read GitHub' (not 'doesn't hold'), and readUpToDateRequired is null", async () => {
    const exec = retryingExec(gh(() => fail("error connecting to api.github.com")), world().options);
    const read = readMainProtection(exec, "/opt/homebrew/bin/gh", "ap9000/toolroll");
    await expect(read).rejects.toBeInstanceOf(ProtectionUnreadable);
    await expect(read).rejects.toThrow(/couldn't read GitHub's branch protection for main: classic protection \(error connecting to api\.github\.com\)/);
    expect(await readUpToDateRequired(exec, "/opt/homebrew/bin/gh", "ap9000/toolroll")).toBeNull();
  });

  test("a truncated classic answer (exit 0) is couldn't-read too, never holds", async () => {
    await expect(readMainProtection(gh(() => ok("{\"required_status_")), "/opt/homebrew/bin/gh", "ap9000/toolroll")).rejects.toBeInstanceOf(ProtectionUnreadable);
  });

  test("read and ineffective stays 'doesn't hold', with what's missing", async () => {
    const answer = await readMainProtection(gh(() => ok(JSON.stringify({ ...live, enforce_admins: { enabled: false } }))), "/opt/homebrew/bin/gh", "ap9000/toolroll");
    expect(answer).toMatchObject({ effective: false, missing: [expect.stringMatching(/Do not allow bypassing/)] });
  });

  test("one layer holding is enough even when another couldn't be read", async () => {
    expect(await readMainProtection(gh(() => ok(JSON.stringify(live)), () => fail("HTTP 502")), "/opt/homebrew/bin/gh", "ap9000/toolroll")).toMatchObject({ effective: true });
  });
});


describe("retry time is bounded even when the clock or scheduler misbehaves", () => {
  test.each(["fixed", "backward"])("a %s clock still charges every backoff against the budget", async clock => {
    let at = 0, slept = 0;
    await retryCall(async () => fail("HTTP 502"), "read", {
      say: () => {}, now: () => new Date(at), sleep: async ms => { slept += ms; if (clock === "backward") at -= ms; },
    });
    expect(slept).toBeLessThanOrEqual(NET_RETRY_BUDGET_MS);
  });

  test("no new call starts after an oversleep", async () => {
    let at = 0, calls = 0;
    await retryCall(async () => { calls++; return fail("HTTP 502"); }, "read", {
      budgetMs: 3_000, say: () => {}, now: () => new Date(at), sleep: async () => { at += 4_000; },
    });
    expect(calls).toBe(1);
  });

  test("each child timeout fits the remaining budget, including call execution", async () => {
    let at = 0;
    const timeouts: number[] = [];
    const run: Exec = async (_command, _args, options) => {
      const timeout = options?.timeoutMs ?? 120_000;
      timeouts.push(timeout); at += Math.min(1_000, timeout);
      return fail("HTTP 502");
    };
    await retryingExec(run, { budgetMs: 3_500, say: () => {}, now: () => new Date(at), sleep: async ms => { at += ms; } })("gh", ["api", "repos/a/b"]);
    expect(at).toBeLessThanOrEqual(3_500);
    expect(timeouts).toEqual([3_500, 500]);
  });

  test("a write and all its recovery reads share one budget even with a frozen clock", async () => {
    let slept = 0, writes = 0, reads = 0;
    const options = { budgetMs: 8_000, say: () => {}, now: () => new Date(0), sleep: async (ms: number) => { slept += ms; } };
    await expect(writeWithRecheck("tag", options, {
      write: async () => { writes++; return fail("HTTP 502"); }, accept: () => true,
      refuse: result => { throw new Error(result.stderr); },
      recheck: async bounded => {
        await retryCall(async () => { reads++; return fail("HTTP 502"); }, "recover", bounded ?? options);
        return { state: "not-done" };
      },
    })).rejects.toThrow();
    expect(slept).toBeLessThanOrEqual(8_000);
    expect(writes).toBe(1);
    expect(reads).toBeLessThanOrEqual(3);
  });
});
