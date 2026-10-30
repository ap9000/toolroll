/** A command that can write must never acquire blind retries through argv spelling. No real credentials or network. */
import { describe, expect, test } from "vitest";
import { retryingExec } from "../../src/release-net.js";

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
