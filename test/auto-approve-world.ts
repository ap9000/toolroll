/**
 * The automatic-approval attack suite's shared world (test/attacks/auto-approve-green*.test.ts, docs/plans/auto-approve-green.md):
 * a release fixture per test, closed after it, and the plane's own calls the attacks drive. The suite is split over
 * files only so CI can run its halves side by side; every attack is unchanged.
 */
import { afterEach, describe, expect, test } from "vitest";
import { releaseFixture, builtRun, sealedCheck, reportOf, RELEASE_NOW, EVIDENCE, type ReleaseFixture } from "./release-fixture.js";
import { authorizeAutoCheck, ciProblem, giveUpAutoApproval, holdApprovalForCi, liftCiHold, sealAutoGreen, setReleaseApproval, type CiObservation } from "../src/release-auto.js";
import { noteCiRunning, releaseCiRunningOf, RELEASE_CI_RUNNING_WORDS } from "../src/release-ci-hold.js";
import { releaseAutoApproves } from "../src/release-authority.js";
import { approve, liveReleaseOf, personApprovalOf, propose, releaseApprovalOf } from "../src/scope.js";
import { releaseAuthorityOfTask } from "../src/store.js";
import { scopeApprovedForDispatch } from "../src/dispatch.js";
import { deploymentGate } from "../src/deploy-gate.js";
import { mergePullRequest } from "../src/pull-request-flow.js";
import { assignmentOf } from "../src/assignment.js";
import { runReleaseCommand } from "../src/release-cli.js";
import { REQUIRED_PR_CHECKS, REQUIRED_PR_CHECKS_WORKFLOW } from "../src/release.js";
import { RELEASE_RECHECK_ACTION, retriedOfRun, SETUP_REPLAY_RETRY, setupReplayWords } from "../src/check-failure.js";
import { launchFailedBeforeCheck } from "../src/builder.js";
import { CHECK_REPORT_CAPTURE, CheckBaselineUnverifiable } from "../src/check-report.js";
import { verificationEvidence } from "../src/verification-evidence.js";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";


/** The test's release fixture, closed after each test. */
export const held: { fixture: ReleaseFixture | null } = { fixture: null };
afterEach(() => { held.fixture?.close(); held.fixture = null; });
export const LATER = new Date(RELEASE_NOW.getTime() + 60_000);
export const UNITS = ["src/index.test.ts", "src/browser/app.test.ts"];
/** A passing Full check reports every unit file it owed (check-report.ts fullCheckProblem): the tree's own. */
export const passingReport = (units: readonly string[] = UNITS) => reportOf(units.map(file => ({ file })));

/** An unapproved release task in a project whose releases approve themselves (alex turned it on). */
export function open(options: Parameters<typeof releaseFixture>[0] = {}) {
  const f = (held.fixture = releaseFixture({ approve: false, ...options }));
  setReleaseApproval(f.store, f.repo, true, "alex", RELEASE_NOW);
  return f;
}
export const digestOf = (f: ReleaseFixture) => f.store.getScope(f.taskId)!.digest;
export const ref = (f: ReleaseFixture) => f.store.refFor("built-in", f.taskId).id;
export const green = (head: string, at = LATER): CiObservation => ({ head, observedAt: at.toISOString(),
  runs: REQUIRED_PR_CHECKS.map((name, i) => ({ id: 1000 + i, name, status: "completed", conclusion: "success", app: "github-actions", suite: 7, head, workflowPath: REQUIRED_PR_CHECKS_WORKFLOW[name] })), complete: true });
/** The plane's auto-check, with the base GitHub names for the candidate (the main commit the branch left). */
export const authorize = (f: ReleaseFixture, base = f.base) => authorizeAutoCheck(f.store, { taskId: f.taskId, digest: digestOf(f), candidate: f.approved, base, now: LATER });
/** The release check of the candidate, sealed as the builder seals it, on the build's real base. */
export const check = (f: ReleaseFixture, head = f.approved, report: (units: readonly string[]) => ReturnType<typeof reportOf> = passingReport) => sealedCheck(f, f.taskId, head, (_plan, units) => report(units), { base: f.base }).runId;
/** A release check Toolroll's own shutdown stopped (the plane's own record), rerun by the release unless `rerun` is false. */
export const infraCheck = (f: ReleaseFixture, rerun = true) => {
  const run = sealedCheck(f, f.taskId, f.approved, () => null, { base: f.base, plane: { configured: true, ran: false, attemptFailed: true, failure: "stopped-by-toolroll" } }).runId;
  if (rerun) rerunRecorded(f, run);
  return run;
};
export const rerunRecorded = (f: ReleaseFixture, run: number) => f.store.recordAction({ at: LATER.toISOString(), actor: "toolroll", repo: f.repo, taskId: f.taskId, runId: run, action: RELEASE_RECHECK_ACTION, outcome: "infrastructure", source: "work" });
export const receiptOf = (f: ReleaseFixture) => assignmentOf(f.store, f.taskId, LATER, { principal: "operator", repos: null, includeUnplaced: true }, EVIDENCE(f))!.receipt!.digest;
export const seal = (f: ReleaseFixture, run: number, ci: CiObservation = green(f.approved), extra: { digest?: string; receipt?: string; mainUpToDate?: boolean | null } = {}) =>
  sealAutoGreen(f.store, { taskId: f.taskId, digest: extra.digest ?? digestOf(f), candidate: f.approved, run, receipt: extra.receipt ?? receiptOf(f), ci, evidenceRoot: EVIDENCE(f), now: LATER,
    mainUpToDate: extra.mainUpToDate === undefined ? true : extra.mainUpToDate });
export const basis = (f: ReleaseFixture) => f.store.getScope(f.taskId)!.approvalBasis ?? null;
