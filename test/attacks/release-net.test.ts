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
