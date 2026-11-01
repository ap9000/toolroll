/** A command that can write must never acquire blind retries through argv spelling. No real credentials or network. */
import { describe, expect, test } from "vitest";
import { retryingExec, writeWithRecheck } from "../../src/release-net.js";

describe("release retries never replay a write disguised as a read", () => {
  test.each([
    ["combined method", ["api", "repos/a/b/issues", "-iXPOST"]],
    ["combined raw field", ["api", "repos/a/b/issues", "-ifbody=again"]],
    ["combined typed field", ["api", "repos/a/b/issues", "-iFbody=again"]],
    ["GraphQL mutation", ["api", "graphql", "-ifquery=mutation { deleteIssue(input: { issueId: \"x\" }) { clientMutationId } }"]],
    ["GraphQL endpoint", ["api", "graphql"]],
    ["input", ["api", "repos/a/b/issues", "--input=body.json"]],
    ["explicit method", ["api", "repos/a/b/issues", "--method=POST"]],
    ["PR merge", ["pr", "merge", "7"]],
  ])("%s is called only once", async (_name, args) => {
    let writes = 0;
    const run = retryingExec(async () => { writes++; return { code: 1, stdout: "", stderr: "HTTP 502: Bad Gateway" }; },
      { say: () => {}, sleep: async () => {}, now: () => new Date(0) });
    expect((await run("/opt/homebrew/bin/gh", args)).code).toBe(1);
    expect(writes).toBe(1);
  });
});


describe("a refusal cannot become transient through accompanying network or rate-limit text", () => {
  test.each([
    "gh: Head branch was modified (HTTP 409)\nsecondary rate limit",
    "Toolroll won't run Git: its Git config sets url.https://host/Connection reset.insteadof",
    "gh: Bad credentials (HTTP 401)\nHTTP 429: Too Many Requests",
    "gh: Resource not accessible by integration (HTTP 403)\nsecondary rate limit",
    "gh: Validation Failed (HTTP 422)\nToo Many Requests",
    "remote: error: GH006: Protected branch update failed\nRPC failed; HTTP 502",
    "fatal: unable to access: The requested URL returned error: 403\nConnection reset",
  ])("%s stops both reads and writes immediately", async stderr => {
    let reads = 0, writes = 0, rechecks = 0;
    const refusal = { code: 1, stdout: "", stderr };
    const options = { say: () => {}, sleep: async () => {}, now: () => new Date(0) };
    const read = retryingExec(async () => ++reads === 1 ? refusal : { code: 0, stdout: "{}", stderr: "" }, options);
    expect(await read("gh", ["api", "repos/a/b"])).toEqual(refusal);
    await expect(writeWithRecheck("merge", options, {
      write: async () => ++writes === 1 ? refusal : { code: 0, stdout: "{}", stderr: "" },
      accept: () => true, refuse: result => { throw new Error(result.stderr); },
      recheck: async () => { rechecks++; return { state: "not-done" }; },
    })).rejects.toThrow(stderr);
    expect([reads, writes, rechecks]).toEqual([1, 1, 0]);
  });
});

import { releaseAdapters, type Exec } from "../../src/release-adapters.js";
const HEAD = "a".repeat(40), MERGE = "b".repeat(40), TREE = "c".repeat(40);
const ok = (body: unknown) => ({ code: 0, stdout: JSON.stringify(body), stderr: "" });
const lost = { code: 1, stdout: "", stderr: "HTTP 502: Bad Gateway" };
const adapters = (run: Exec) => releaseAdapters({ checkout: "/unused", database: "/nonexistent/toolroll.db", run,
  tools: { git: "/usr/bin/git", gh: "/opt/homebrew/bin/gh", ssh: "/usr/bin/ssh" },
  now: () => new Date(0), sleep: async () => {}, say: () => {} });

describe("a merge result must still be the approved change", () => {
  test.each(["release", "tap"] as const)("%s: an open PR cannot authorize a second merge under stale coordinator checks", async kind => {
    let writes = 0;
    const run: Exec = async (_command, args) => {
      if (args.includes("PUT")) return ++writes === 1 ? lost : ok({ merged: true, sha: MERGE });
      if (args.includes(".default_branch")) return { code: 0, stdout: "main", stderr: "" };
      return ok({ merged: false, state: "open", head: { sha: HEAD }, base: { ref: "main" } });
    };
    const a = adapters(run);
    await expect(kind === "release" ? a.github.merge("a/b", 7, HEAD) : a.homebrew.merge(7, HEAD)).rejects.toThrow();
    expect(writes).toBe(1);
  });

  test.each([
    ["another head", { head: { sha: TREE } }, {}],
    ["another base", { base: { ref: "unprotected" } }, {}],
    ["non-squash merge", {}, { parents: [{ sha: HEAD }, { sha: TREE }] }],
    ["different tree", {}, { tree: { sha: MERGE } }],
  ])("a merge by another caller at %s is not adopted", async (_name, pull, commit) => {
    const run: Exec = async (_command, args) => {
      if (args.includes("PUT")) return lost;
      const path = args.find(arg => arg.startsWith("repos/")) ?? "";
      if (path.endsWith(`/git/commits/${HEAD}`)) return ok({ tree: { sha: TREE } });
      if (path.endsWith(`/git/commits/${MERGE}`)) return ok({ tree: { sha: TREE }, parents: [{ sha: TREE }], ...commit });
      return ok({ merged: true, state: "closed", head: { sha: HEAD }, base: { ref: "main" }, merge_commit_sha: MERGE, ...pull });
    };
    await expect(adapters(run).github.merge("a/b", 7, HEAD)).rejects.toThrow();
  });

  test.each([false, undefined])("a successful HTTP response with merged=%s is a refusal", async merged => {
    await expect(adapters(async () => ok({ merged, sha: MERGE })).github.merge("a/b", 7, HEAD)).rejects.toThrow();
  });

  test("an existing tag at another commit is never accepted or rewritten", async () => {
    let writes = 0;
    await expect(adapters(async (_command, args) => {
      if (args.includes("POST")) { writes++; return lost; }
      return ok({ object: { type: "commit", sha: HEAD } });
    }).github.createTag("a/b", "v1", MERGE)).rejects.toThrow();
    expect(writes).toBe(1);
  });
});


describe("Git global option values cannot disguise a push as a read", () => {
  test.each(["--git-dir", "--work-tree", "--namespace"])("%s consumes its value", async flag => {
    let writes = 0;
    const run = retryingExec(async () => { writes++; return lost; }, { say: () => {}, sleep: async () => {}, now: () => new Date(0) });
    await run("/usr/bin/git", [flag, "fetch", "push", "origin", "HEAD"]);
    expect(writes).toBe(1);
  });
});
