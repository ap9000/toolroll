/**
 * Rerunning a release check (2026-10-27): release-0.9.73's check failed on a flaky test, `task regate` rewrote the
 * task's candidate to the attempt's own build commit (same tree, new sha), and `toolroll release` refused the passing
 * rerun as "candidate or scope changed after approval". The fix keeps a prepared candidate's scope and approval exactly
 * as the person sealed them; the rerun builds that same tree again. Attacks: a regate never swaps in other code, another
 * base or other words under the standing approval, never reuses the failed run's result, and never launders a carried
 * approval. Records are real (a real repository, a person's approval with release terms), checks sealed as the builder
 * seals them.
 */
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { releaseFixture, sealedCheck, reportOf, RELEASE_NOW, EVIDENCE, type ReleaseFixture } from "../release-fixture.js";
import { maybeTriggerRepair, regateTask } from "../../src/dispose.js";
import { deploymentGate } from "../../src/deploy-gate.js";
import { gateStateOf } from "../../src/release-adapters.js";
import { runOperate } from "../../src/operate.js";
import { liveReleaseOf, propose, approve } from "../../src/scope.js";
import { proveCarry } from "../../src/release-carry.js";
import { verificationEvidence } from "../../src/verification-evidence.js";
import { assignmentOf } from "../../src/assignment.js";
import * as installedScope from "../../src/scope.js";
import { presetTerms, modeTermsJson, modeDigestOf } from "../../src/modes.js";
// @ts-expect-error plain ESM script without declarations
import { deploymentCandidate } from "../../scripts/deploy-candidate.mjs";

let fixture: ReleaseFixture | null = null;
afterEach(() => { fixture?.close(); fixture = null; });
const LATER = new Date(RELEASE_NOW.getTime() + 60_000);
const UNITS = ["src/browser/app.test.ts", "src/index.test.ts", "test/attacks/fence.test.ts"];
/** Every unit passes, the flaky identity among them (coverage is conserved: a test that failed once must be seen passing). */
const allPass = () => reportOf(UNITS.map(file => file === "src/index.test.ts" ? { file, passed: ["answer"] } : { file }));
const flaky = () => reportOf(UNITS.map(file => file === "src/index.test.ts" ? { file, failed: ["answer"] } : { file }));
const alex = (f: ReleaseFixture) => ({ kind: "operator" as const, name: "alex", token: f.password });

/** The build's own commit of the candidate: exactly its tree, on top of it (as the prepared road records it). */
const buildCommit = (f: ReleaseFixture, of: string) => f.git("commit-tree", `${of}^{tree}`, "-p", of, "-m", `Release task ${f.taskId}`);

/** A finished attempt of `taskId` at `head` whose check is `report`, settled as disposal settles it. */
function attempt(f: ReleaseFixture, taskId: string, head: string, report: typeof allPass, outcome: "built" | "no-change" = "built") {
  const { runId } = sealedCheck(f, taskId, head, report, { forceFull: true });
  if (outcome === "no-change") f.store.handle.prepare("UPDATE run SET outcome = 'no-change' WHERE id = ?").run(runId);
  const passed = f.store.handle.prepare("SELECT status FROM run_check WHERE run = ?").get(runId)?.["status"] === "passed";
  if (!passed) f.store.saveProofVerdict(runId, "refuted", ["the approved release check failed"], RELEASE_NOW, []);
  f.store.setTaskState(taskId, "done", RELEASE_NOW);
  return runId;
}

/** What `toolroll release` reads for the task: `task show --json` over the same plane, through the real adapter. */
async function gateOf(f: ReleaseFixture, taskId: string) {
  const lines: string[] = [];
  await runOperate("task", ["show", taskId, "--json"], line => lines.push(line), { databaseFile: f.databaseFile, now: LATER });
  return gateStateOf(JSON.parse(lines.join("\n")) as Record<string, unknown>);
}

/** A release whose check failed once on its build commit. */
function failedRelease() {
  const f = (fixture = releaseFixture());
  // The CLI reads evidence beside its database; the fixture seals it in the fixture folder.
  mkdirSync(EVIDENCE(f), { recursive: true });
  symlinkSync(EVIDENCE(f), join(f.dir, "state", "evidence"));
  const built = buildCommit(f, f.approved);
  const failed = attempt(f, f.taskId, built, flaky);
  const before = f.store.getScope(f.taskId)!;
  return { f, built, failed, before };
}

describe("a regated release check of the unchanged approved commit", () => {
  test("fail, regate, pass: the scope and the person's approval stand, and the passing rerun is the release's result", async () => {
    const { f, built, failed, before } = failedRelease();
    expect(f.git("rev-parse", `${built}^{tree}`)).toBe(f.git("rev-parse", `${f.approved}^{tree}`));
    const rerun = regateTask(f.store, f.taskId, LATER, alex(f));
    expect(rerun).toEqual({ ok: true, run: failed, head: f.approved });
    // Nothing about the approval moved: the same commit, words, release terms and seal.
    const after = f.store.getScope(f.taskId)!;
    expect(after).toMatchObject({ candidate: f.approved, digest: before.digest, approvedDigest: before.digest, approvedBy: before.approvedBy,
      approvedAt: before.approvedAt, approvalBasis: before.approvalBasis });
    expect(after.releaseTerms).toEqual(before.releaseTerms);
    expect(f.store.getTask(f.taskId)?.state).toBe("queued");
    expect(liveReleaseOf(f.store, f.taskId, "dispatch", LATER)).toMatchObject({ applies: true, ok: true });

    // While the rerun is on its way, the release sees the failure before it as pending, never as its answer.
    const waiting = await gateOf(f, f.taskId);
    expect(waiting).toMatchObject({ candidate: f.approved, scopeDigest: before.digest, pending: true, result: { run: failed, check: "failed" } });

    // The rerun finds its branch already at the build commit: no-change, a fresh passing check of the same tree.
    const passed = attempt(f, f.taskId, built, allPass, "no-change");
    const gate = await gateOf(f, f.taskId);
    expect(gate).toMatchObject({ candidate: f.approved, scopeDigest: before.digest, pending: false, failed: null,
      result: { run: passed, head: built, check: "passed", level: "full" } });
    expect(gate.result?.receipt).not.toBe((waiting.result?.receipt));
    // Both deploy gates take the rerun as the candidate; they stop only where completion is owed.
    expect(deploymentGate(f.store, { runId: passed, evidenceRoot: EVIDENCE(f), now: LATER })).toEqual({ ok: false, message: "The lead or user has not marked this exact result complete." });
    expect(() => deploymentCandidate(f.store, { runId: passed, head: built, evidenceRoot: EVIDENCE(f), now: LATER }, { assignmentOf, verificationEvidence, installedScope }))
      .toThrow("The lead or user has not marked this exact result complete.");
  }, 120_000);

  test("a second failure on the same approved commit goes to a person: no repair, no third pass", () => {
    const { f, built } = failedRelease();
    expect(regateTask(f.store, f.taskId, LATER, alex(f))).toMatchObject({ ok: true });
    const again = attempt(f, f.taskId, built, flaky, "no-change");
    expect(maybeTriggerRepair(f.store, f.repo, EVIDENCE(f), again, "refuted", LATER, "verification")).toEqual({ kind: "none" });
    expect(f.store.handle.prepare("SELECT subject FROM notification WHERE dedupe_key = ?").get(`regate-failed:${again}`)?.["subject"]).toBe("The project check failed again on the same commit");
    expect(f.store.repairChainFor(again)).toBeNull();
  }, 120_000);

  test("the automatic rerun under a mode keeps the person's seal too: no mode approval replaces it", () => {
    const { f, before } = failedRelease();
    const mode = { kind: "mode" as const, name: "overnight", modeDigest: "m".repeat(64) };
    expect(regateTask(f.store, f.taskId, LATER, mode)).toMatchObject({ ok: true, head: f.approved });
    expect(f.store.getScope(f.taskId)).toMatchObject({ digest: before.digest, approvedDigest: before.digest, approvedBy: "alex", approvalBasis: before.approvalBasis });
  });
});

describe("attack: a regate never stands in for different code, base or words", () => {
  test("a rerun whose result holds a different tree is not the release's candidate", async () => {
    const { f } = failedRelease();
    expect(regateTask(f.store, f.taskId, LATER, alex(f))).toMatchObject({ ok: true });
    // A commit with other files at the same place, recorded as a no-change rerun: no earlier build of it, so no candidate.
    const other = f.git("commit-tree", f.git("rev-parse", `${f.commit({ "src/index.js": "export const answer = 41;\n" })}^{tree}`), "-p", f.approved, "-m", "other");
    const run = attempt(f, f.taskId, other, allPass, "no-change");
    expect(deploymentGate(f.store, { runId: run, evidenceRoot: EVIDENCE(f), now: LATER })).toMatchObject({ ok: false, message: `Run ${run} is not a built candidate at ${other.slice(0, 7)}.` });
    expect(() => deploymentCandidate(f.store, { runId: run, head: other, evidenceRoot: EVIDENCE(f), now: LATER }, { assignmentOf, verificationEvidence, installedScope }))
      .toThrow(`Run ${run} is not a built candidate at ${other.slice(0, 7)}.`);
  }, 120_000);

  test("a regate after the scope was changed (other words, another base commit) refuses; nothing is re-proposed or sealed", () => {
    const { f, before } = failedRelease();
    // Re-scoped to a different candidate and left unapproved: the regate does not seal it in the operator's name.
    const moved = f.commit({ "src/index.js": "export const answer = 43;\n" });
    propose(f.store, { taskId: f.taskId, goal: "Verify something else", candidate: moved, acceptance: before.acceptance, releaseTerms: before.releaseTerms ?? null, now: LATER });
    const changed = f.store.getScope(f.taskId)!;
    expect(regateTask(f.store, f.taskId, LATER, alex(f))).toMatchObject({ ok: false, reason: "not-approved" });
    expect(f.store.getScope(f.taskId)).toMatchObject({ digest: changed.digest, candidate: moved, approvedDigest: before.digest });
    expect(f.store.getTask(f.taskId)?.state).toBe("done");
    // Approved by the person after all: the failed attempt was under the old words, so the regate still refuses.
    expect(approve(f.store, f.taskId, "alex", LATER, changed.digest, f.password).ok).toBe(true);
    expect(regateTask(f.store, f.taskId, LATER, alex(f))).toMatchObject({ ok: false, reason: "not-approved" });
    expect(f.store.getTask(f.taskId)?.state).toBe("done");
  });

  test("a rerun under changed words is no candidate, even at the same build commit", () => {
    const { f, built, before } = failedRelease();
    expect(regateTask(f.store, f.taskId, LATER, alex(f))).toMatchObject({ ok: true });
    propose(f.store, { taskId: f.taskId, goal: "Verify, reworded", candidate: f.approved, acceptance: before.acceptance, releaseTerms: before.releaseTerms ?? null, now: LATER });
    expect(approve(f.store, f.taskId, "alex", LATER, f.store.getScope(f.taskId)!.digest, f.password).ok).toBe(true);
    const run = attempt(f, f.taskId, built, allPass, "no-change");
    // The build at that commit was under the old words: the rerun is not that build's check again.
    expect(deploymentGate(f.store, { runId: run, evidenceRoot: EVIDENCE(f), now: LATER })).toMatchObject({ ok: false, message: `Run ${run} is not a built candidate at ${built.slice(0, 7)}.` });
  }, 120_000);

  test("the failed run's own result is never the regated release's result", async () => {
    const { f, failed, built } = failedRelease();
    expect(regateTask(f.store, f.taskId, LATER, alex(f))).toMatchObject({ ok: true });
    expect(deploymentGate(f.store, { runId: failed, evidenceRoot: EVIDENCE(f), now: LATER })).toMatchObject({ ok: false, message: "The native check did not pass this candidate under the currently approved command." });
    // A second regate before the rerun has run is no second rerun of a result: the task is simply queued.
    expect(regateTask(f.store, f.taskId, LATER, alex(f))).toMatchObject({ ok: true });
    const rerun = attempt(f, f.taskId, built, flaky, "no-change");
    // Failed again on the same commit: the gate stays shut, and the newest result is the rerun's, not run `failed`.
    expect((await gateOf(f, f.taskId)).result).toMatchObject({ run: rerun, check: "failed" });
    expect(deploymentGate(f.store, { runId: rerun, evidenceRoot: EVIDENCE(f), now: LATER })).toMatchObject({ ok: false, message: "The native check did not pass this candidate under the currently approved command." });
  }, 120_000);

  test("a regate of a release whose approval was stopped refuses", () => {
    const { f } = failedRelease();
    f.store.handle.prepare("UPDATE release_authority SET state = 'revoked', ended_by = 'alex' WHERE id = ?").run(f.authority().id);
    expect(regateTask(f.store, f.taskId, LATER, alex(f))).toMatchObject({ ok: false, reason: "not-approved", message: expect.stringContaining("stopped carrying commits") });
    expect(f.store.getTask(f.taskId)?.state).toBe("done");
  });

  test("Codex round 1: a prepared task whose mode seal expired is refused, not queued for a rerun that can't start", () => {
    const f = (fixture = releaseFixture());
    const terms = presetTerms("hands-off", new Date(LATER.getTime() - 1_000).toISOString());
    const digest = modeDigestOf(terms);
    f.store.signMode({ repo: f.repo, name: "hands-off", termsJson: modeTermsJson(terms), digest, signedBy: "alex", absoluteExpiry: terms.absoluteExpiry, publication: terms.publication }, RELEASE_NOW);
    const task = "nightly-gate";
    f.store.createTask({ id: task, title: "Check the prepared commit" }, RELEASE_NOW);
    f.store.placeTask(f.store.refFor("built-in", task).id, f.repo, {}, RELEASE_NOW);
    propose(f.store, { taskId: task, goal: "Check the prepared commit", candidate: f.approved, acceptance: [{ id: "c1", statement: "The check passes", how: null, evidence: ["check"] }], now: RELEASE_NOW });
    expect(f.store.sealScopeApproval(task, "mode hands-off", RELEASE_NOW, {}, { kind: "mode", modeDigest: digest })).toBe(true);
    attempt(f, task, buildCommit(f, f.approved), flaky);
    // The mode expired before the rerun was asked for: its seal no longer dispatches anything.
    expect(f.store.modeApprovalLive(f.store.refFor("built-in", task).id, LATER)).toBe(false);
    expect(regateTask(f.store, task, LATER, alex(f))).toMatchObject({ ok: false, reason: "not-approved", message: expect.stringContaining("approval no longer stands") });
    expect(f.store.getTask(task)?.state).toBe("done");
    expect(f.store.getScope(task)?.approvalBasis).toBe("mode");
  }, 120_000);

  test("a carried commit's regate keeps its carried seal exactly, and the carry still has to match", async () => {
    const f = (fixture = releaseFixture());
    const to = f.commit({ "docs/guide.md": "# Guide\nfixed\n" });
    const carried = await proveCarry(f.store, { authority: f.authority().id, to, now: LATER });
    if (!carried.ok) throw new Error(carried.message);
    const task = carried.taskId;
    const before = f.store.getScope(task)!;
    expect(before.approvalBasis).toBe("carried");
    const failed = attempt(f, task, buildCommit(f, to), flaky);
    expect(regateTask(f.store, task, LATER, alex(f))).toEqual({ ok: true, run: failed, head: to });
    expect(f.store.getScope(task)).toMatchObject({ candidate: to, digest: before.digest, approvedDigest: before.digest, approvalBasis: "carried", modeDigest: before.modeDigest });
    expect(liveReleaseOf(f.store, task, "dispatch", LATER)).toMatchObject({ applies: true, ok: true });
    // A carried seal never covers different words: re-scoped, the regate refuses rather than sealing them for the operator.
    propose(f.store, { taskId: task, goal: "Verify something else", candidate: to, acceptance: before.acceptance, releaseTerms: before.releaseTerms ?? null, now: LATER });
    f.store.setTaskState(task, "done", LATER);
    expect(regateTask(f.store, task, LATER, alex(f))).toMatchObject({ ok: false, reason: "not-approved" });
    expect(f.store.getScope(task)?.approvedDigest).toBe(before.digest);
  }, 120_000);
});
