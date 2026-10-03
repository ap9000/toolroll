import { describe, expect, test } from "vitest";
// @ts-expect-error plain ESM script without declarations
import { deploymentCandidate } from "../scripts/deploy-candidate.mjs";

const HEAD = "a".repeat(40);
const COMMAND = "npm run verify";
const DIGEST = "scope-digest";

type Run = { id: number; taskRef: number; role: string; outcome: string; headRevision: string; scopeDigest: string; worktree: string };

function fixture(runs: Run[], receipts: Record<number, object | null>) {
  const store = {
    getRun: (id: number) => runs.find(one => one.id === id) ?? null,
    runsFor: (taskRef: number) => runs.filter(one => one.taskRef === taskRef).sort((a, b) => b.id - a.id),
    refById: () => ({ externalId: "t1", repo: "/repo" }),
    getScope: () => ({ digest: DIGEST, approvedDigest: DIGEST, candidate: HEAD, acceptance: [] }),
    liveVerifyCommand: () => ({ command: COMMAND }),
    proofVerdictFor: () => null,
    proofAcceptance: () => null,
  };
  const deps = {
    verificationEvidence: (_store: unknown, _root: string, runId: number) => {
      const receipt = receipts[runId];
      return receipt ? { ok: true, bytes: JSON.stringify(receipt), digest: `gate-${runId}` } : { ok: false, bytes: null, problem: "no receipt" };
    },
    assignmentOf: () => ({ state: "complete", receipt: { runId: 2, head: HEAD, scopeDigest: DIGEST, digest: "r" }, completion: { digest: "r" } }),
  };
  return (runId: number) => deploymentCandidate(store, { runId, head: HEAD, evidenceRoot: "/evidence", now: new Date() }, deps);
}

const built: Run = { id: 1, taskRef: 7, role: "builder", outcome: "built", headRevision: HEAD, scopeDigest: "old-digest", worktree: "/w1" };
const regate: Run = { id: 2, taskRef: 7, role: "builder", outcome: "no-change", headRevision: HEAD, scopeDigest: DIGEST, worktree: "/w2" };
const passing = { run: 2, head: HEAD, scopeDigest: DIGEST, result: { ran: true, exitCode: 0 }, command: { command: COMMAND } };

describe("deploymentCandidate", () => {
  test("a regate of the last built commit deploys on its own passing receipt", () => {
    const result = fixture([built, regate], { 2: passing })(2);
    expect(result).toMatchObject({ taskId: "t1", scopeDigest: DIGEST, gateDigest: "gate-2", worktree: "/w2" });
  });

  test("a no-change run without a passing receipt is refused", () => {
    expect(() => fixture([built, regate], {})(2)).toThrow("Native check unavailable: no receipt.");
    const failed = { ...passing, result: { ran: true, exitCode: 1 } };
    expect(() => fixture([built, regate], { 2: failed })(2)).toThrow("did not pass this candidate");
  });

  test("a no-change run that is not a regate of the last built commit is refused", () => {
    expect(() => fixture([regate], { 2: passing })(2)).toThrow("Run 2 is not a built candidate");
    const elsewhere = { ...built, headRevision: "b".repeat(40) };
    expect(() => fixture([elsewhere, regate], { 2: passing })(2)).toThrow("Run 2 is not a built candidate");
  });
});
