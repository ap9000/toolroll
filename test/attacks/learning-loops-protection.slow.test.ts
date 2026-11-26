/**
 * Attack: make a check's own output move its outcome (docs/plans/learning-loops.md, Safety, Protection 5).
 * Guard: check-facts.ts only ever writes advisory rows, tested with real sandboxed process output on macOS.
 * The platform-free release-policy attacks (Protection 1-4) live in test/attacks/auto-approve-learning-loops.slow.test.ts.
 */
import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { authorize, open, passingReport, seal } from "../auto-approve-world.js";
import { EVIDENCE, sealedCheck, type ReleaseFixture } from "../release-fixture.js";
import { captureCheckConditions, checkFactOf, checkResultsOf, recordCheckFacts } from "../../src/check-facts.js";
import { LEARN_MAX_BYTES, LEARN_PREFIX } from "../../src/contracts/release-check.js";
import { verificationEvidence } from "../../src/verification-evidence.js";
import { classifyRunCheck } from "../../src/check-failure.js";
import { RELEASE_NOW } from "../release-fixture.js";

/** A release check of the candidate, sealed as the builder seals it, its facts recorded as the builder records them. */
function recorded(f: ReleaseFixture, before: (nonce: string) => string) {
  const sealed = sealedCheck(f, f.taskId, f.approved, (_plan, units) => passingReport(units), { base: f.base, learn: ["unit:src/index.test.ts::answer"], stdoutBefore: before });
  const conditions = captureCheckConditions({ repo: f.repo, head: f.approved, command: sealed.command, access: "sandboxed", envNames: ["PATH", "HOME"] });
  recordCheckFacts(f.store, EVIDENCE(f), { runId: sealed.runId, taskRef: f.store.refFor("built-in", f.taskId).id, repo: f.repo, conditions, receipt: { status: sealed.status },
    report: sealed.report, attempt: { nonce: sealed.prepared.nonce, learn: sealed.prepared.learn }, stdout: sealed.stdout, now: RELEASE_NOW });
  return sealed;
}
/** The lines a candidate's check prints, produced by a real process (inside the OS sandbox where one exists). */
function printed(text: string): string {
  const sandbox = process.platform === "darwin" ? ["/usr/bin/sandbox-exec", "-p", "(version 1)(allow default)(deny network*)(deny file-write*)"] : [];
  const out = spawnSync(sandbox[0] ?? "/bin/sh", [...sandbox.slice(1), ...(sandbox.length > 0 ? ["/bin/sh"] : []), "-c", "cat"], { input: text, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (out.status !== 0) throw new Error(`the printing process failed: ${out.stderr}`);
  return out.stdout;
}

describe("a check's own output can move only advisory rows", () => {
  test("fake FAIL lines, a fake report and fake or flooded learning lines leave run_check, the receipt's standing and the automatic approval as they were", () => {
    const f = open();
    authorize(f);
    const fakes = (nonce: string) => printed([
      " FAIL  src/index.test.ts > answer", " Tests  1 failed",
      `TOOLROLL_CHECK_REPORT ${JSON.stringify({ version: 1, nonce: "0".repeat(64), mode: "full", planDigest: null, exitCode: 1, parts: [], units: null, journeys: [], upgrades: null })}`,
      `${LEARN_PREFIX}${JSON.stringify({ nonce: "e".repeat(64), results: [{ identity: "unit:src/index.test.ts::answer", state: "failed" }] })}`,
      `${LEARN_PREFIX}${JSON.stringify({ nonce, results: [{ identity: "unit:src/index.test.ts::answer", state: "failed" }] }).padEnd(LEARN_MAX_BYTES + 10, " ")}`,
    ].join("\n") + "\n");
    const attacked = recorded(f, fakes);
    expect(f.store.handle.prepare("SELECT status FROM run_check WHERE run = ?").get(attacked.runId)?.["status"]).toBe("passed");
    expect(verificationEvidence(f.store, EVIDENCE(f), attacked.runId).ok).toBe(true);
    expect(classifyRunCheck(f.store, EVIDENCE(f), attacked.runId)).toBeNull();
    // Only advisory rows: no learning line was read, and the receipt says passed.
    expect(checkFactOf(f.store, attacked.runId)).toMatchObject({ learnState: "not-recorded", learnWhy: "the learning line was over 64 KiB" });
    expect(checkResultsOf(f.store, attacked.runId).filter(one => one.source === "receipt")).toEqual([{ identity: "check", state: "passed", source: "receipt" }]);
    // The automatic approval reads this check exactly as it reads a clean one.
    expect(seal(f, attacked.runId)).toMatchObject({ ok: true });
  });

  test("a valid learning line saying a test failed leaves the passing check passing and approved", () => {
    const f = open();
    authorize(f);
    const run = recorded(f, nonce => printed(`${LEARN_PREFIX}${JSON.stringify({ nonce, results: [{ identity: "unit:src/index.test.ts::answer", state: "failed" }] })}\n`));
    expect(checkResultsOf(f.store, run.runId).filter(one => one.source === "learn")).toEqual([{ identity: "unit:src/index.test.ts::answer", state: "failed", source: "learn" }]);
    expect(f.store.handle.prepare("SELECT status FROM run_check WHERE run = ?").get(run.runId)?.["status"]).toBe("passed");
    expect(seal(f, run.runId)).toMatchObject({ ok: true });
  });
});
