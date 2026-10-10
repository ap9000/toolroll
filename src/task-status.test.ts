/** The shared task status (docs/design/task-status.md): every combination the
 * brief names keeps its headline, sentence and detail rows, and red belongs to
 * the Failed headline alone. */
import { describe, expect, test } from "vitest";
import {
  DEMO_CHECKS, HEADLINES, assignmentStatusFacts, demoChecksOf, headlineOf, requirementsOf, unverifiedWhenRefuted, pullRequestFactOf, stageOfCode, stageOfDispatch, statusDetailLines, statusDetailsHtml, taskStatusOf,
  type ChecksFact, type PullRequestFact, type TaskStage, type TaskStatusFacts,
} from "./task-status.js";
import { htmlString } from "./html.js";
import type { AssignmentSnapshot } from "./assignment.js";
import { mixedCheckScreenshot } from "../test/status-evidence-fixture.js";
import { requirementWordOf, completionBlockersOf } from "./task-status.js";

describe("release coverage requires validated non-check evidence", () => {
  test.each([null, { path: "", ok: false, problem: "missing file" }, { path: "", ok: true, bytes: 40, dims: { width: 1, height: 1 } }])("invalid screenshot stays unresolved: %j", shot => {
    const row = mixedCheckScreenshot(shot);
    expect(row.state).toBe("missing");
    for (const release of ["pending", "covered"] as const) {
      expect(requirementWordOf(row, null, release)).toBe("Not shown yet");
    }
    expect(completionBlockersOf({ report: false, checks: { status: "passed", exitCode: 0, level: "full" }, checkRequired: true,
      matrix: [row], verdict: "short", accepted: false, high: 0 })).toMatchObject([{ key: "criteria" }]);
  });

  test("valid screenshot waits only for checks, including stored direct-assessment outcomes", () => {
    const row = mixedCheckScreenshot({ path: "", ok: true, bytes: 5000, dims: { width: 390, height: 844 } });
    expect(requirementWordOf(row, null, "pending")).toBe("Checked at release");
    expect(requirementWordOf(row, null, "covered")).toBe("Met");
    expect(requirementWordOf({ ...row, assessment: { evidenceState: "missing", detail: row.detail } }, null, "covered")).toBe("Met");
    expect(requirementWordOf({ ...row, assessment: { evidenceState: "failed", detail: ["Screenshot could not be verified"] } }, null, "covered")).toBe("Not shown yet");
    expect(requirementWordOf({ ...row, answered: [{ kind: "changed-path", ref: "evidence/checkout.png" }] }, null, "covered")).toBe("Not shown yet");
  });
});

const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const passed: ChecksFact = { status: "passed", exitCode: 0, head: HEAD };
const failed: ChecksFact = { status: "failed", exitCode: 1, head: HEAD };
const pr = (state: PullRequestFact["state"], ci: PullRequestFact["ci"] = null): PullRequestFact =>
  ({ state, number: state === "failed" || state === "opening" || state === "none" ? null : 12, url: state === "failed" ? null : "https://github.com/acme/shop/pull/12", ci, error: state === "failed" ? "remote: GH006: Protected branch update failed." : null });
const row = (status: ReturnType<typeof taskStatusOf>, key: string) => status.details.find(one => one.key === key);

describe("the brief's states", () => {
  test("the reported case: complete, checks passed, the pull request couldn't open — a success with one amber detail", () => {
    const status = taskStatusOf({ stage: "complete", checks: passed, pullRequest: { ...pr("failed"), compareUrl: "https://github.com/acme/shop/compare/main...toolroll/fix?expand=1" },
      requirements: { met: 1, total: 1, yours: 0 }, evidence: { shortened: 0, missing: 0, damaged: 0 }, completedBy: "sam",
      action: { label: "Open result", href: "/chat?task=fix&result=4" } });
    expect(status.headline).toBe("Complete");
    expect(status.tone).toBe("success");
    expect(status.sentence).toBe("Marked complete by sam.");
    expect(status.details.map(one => [one.label, one.text, one.mark])).toEqual([
      ["Project checks", "Passed on a1b2c3d", "ok"],
      ["Pull request", "Couldn't open", "note"],
      ["Requirements", "1 of 1 met", "ok"],
      ["Saved evidence", "Complete", "ok"],
    ]);
    const amber = status.details.filter(one => one.mark === "note");
    expect(amber).toHaveLength(1);
    expect(amber[0]!.action).toEqual({ label: "Open it on GitHub", href: "https://github.com/acme/shop/compare/main...toolroll/fix?expand=1" });
    // The technical reason stays one tap away, never in the headline or sentence.
    expect(amber[0]!.why).toBe("remote: GH006: Protected branch update failed. The commit is safe locally.");
    expect(status.details.some(one => one.mark === "failed")).toBe(false);
    expect(status.primaryAction).toEqual({ label: "Open result", href: "/chat?task=fix&result=4" });
    expect(statusDetailLines(status)).toContain("⚠ Pull request · Couldn't open — Open it on GitHub");
    expect(htmlString(statusDetailsHtml(status))).not.toMatch(/status-detail--failed|danger|destructive/);
  });

  test("without a compare page, the pull request row still offers one action", () => {
    const status = taskStatusOf({ stage: "complete", checks: passed, pullRequest: pr("failed"), links: { pullRequest: "/t/fix#merge" } });
    expect(row(status, "pull-request")!.action).toEqual({ label: "See why", href: "/t/fix#merge" });
  });

  test("ready for review: checks passed on the commit", () => {
    const status = taskStatusOf({ stage: "finished", checks: passed, pullRequest: pr("none") });
    expect([status.headline, status.tone]).toEqual(["Ready for review", "ready"]);
    expect(status.sentence).toBe("Checks passed on a1b2c3d. Review the change, then mark it complete.");
    expect(row(status, "pull-request")).toMatchObject({ text: "None", mark: "none", action: null });
  });

  test("checks failed: the only red headline, its checks row red too", () => {
    const status = taskStatusOf({ stage: "finished", checks: failed, pullRequest: pr("none") });
    expect([status.headline, status.tone]).toEqual(["Failed", "danger"]);
    expect(status.sentence).toBe("Checks failed on a1b2c3d. See what broke, then retry or ask for changes.");
    expect(row(status, "checks")).toMatchObject({ text: "Failed (exit 1)", mark: "failed" });
  });

  test("checks passed, pull request open, CI running", () => {
    const status = taskStatusOf({ stage: "finished", checks: passed, pullRequest: pr("open", "running") });
    expect(status.headline).toBe("Ready for review");
    expect(row(status, "pull-request")).toMatchObject({ text: "#12 open · PR CI running", mark: "running", href: "https://github.com/acme/shop/pull/12" });
  });

  test("complete with a merged pull request", () => {
    const status = taskStatusOf({ stage: "complete", checks: passed, pullRequest: pr("merged"), completedBy: "sam" });
    expect(status.headline).toBe("Complete");
    expect(status.sentence).toBe("Marked complete by sam. Pull request #12 merged.");
    expect(row(status, "pull-request")).toMatchObject({ text: "#12 merged", mark: "ok" });
  });

  test("waiting for approval: Needs you, the sentence says which", () => {
    const status = taskStatusOf({ stage: "needs-you", need: "approval", reason: "Review and sign the current scope before a worker can claim it." });
    expect([status.headline, status.tone, status.sentence]).toEqual(["Needs you", "attention", "Review the plan and approve it to start."]);
    expect(status.details).toEqual([]);
  });

  test("a question waiting: the sentence is the question", () => {
    expect(taskStatusOf({ stage: "needs-you", need: "answer", reason: "Should the CSV include refunds?" }).sentence).toBe("Should the CSV include refunds?");
  });

  test("building, and checks running", () => {
    expect(taskStatusOf({ stage: "building" })).toMatchObject({ headline: "Building", tone: "live", sentence: "An agent is working on it." });
    expect(taskStatusOf({ stage: "checking" })).toMatchObject({ headline: "Building", sentence: "Checks are running on the change." });
  });

  test("stopped by a person", () => {
    expect(taskStatusOf({ stage: "stopped" })).toMatchObject({ headline: "Stopped", tone: "neutral", sentence: "Stopped by a person. The work so far is kept." });
    expect(taskStatusOf({ stage: "stopped", reason: "Cancelled. Nothing else will run." }).sentence).toBe("Cancelled. Nothing else will run.");
  });

  test("a sign-in pause is Needs you", () => {
    expect(stageOfCode("signed-out")).toEqual({ stage: "needs-you", need: "sign-in" });
    expect(taskStatusOf({ stage: "needs-you", need: "sign-in" })).toMatchObject({ headline: "Needs you", sentence: "Your agent needs you to sign in again. The task starts on its own after.", primaryAction: { label: "Sign in again", href: null } });
  });

  test("queued and planning", () => {
    expect(taskStatusOf({ stage: "queued" })).toMatchObject({ headline: "Queued", tone: "neutral", sentence: "Waiting for a worker." });
    expect(taskStatusOf({ stage: "planning" })).toMatchObject({ headline: "Planning", tone: "live", sentence: "The lead is writing the plan." });
    expect(stageOfCode("running", { planning: true })).toEqual({ stage: "planning" });
  });

  test("requirements and saved evidence speak plainly", () => {
    const status = taskStatusOf({ stage: "finished", checks: passed, requirements: { met: 2, total: 3, yours: 1 }, evidence: { shortened: 1, missing: 0, damaged: 0 } });
    expect(row(status, "requirements")).toMatchObject({ text: "2 of 3 met · You check 1", mark: "none" });
    expect(row(status, "evidence")).toMatchObject({ text: "Some output shortened", mark: "note" });
    expect(status.headline).toBe("Ready for review");
  });

  test("a complete task whose checks failed keeps the failure visible in amber, not red", () => {
    const status = taskStatusOf({ stage: "complete", checks: failed, completedBy: "sam" });
    expect(status.headline).toBe("Complete");
    expect(row(status, "checks")).toMatchObject({ text: "Failed (exit 1)", mark: "note", action: { label: "See what failed", href: null } });
  });

  test("a research report reads as a report, without a checks row", () => {
    const status = taskStatusOf({ stage: "finished", report: true, checks: { status: "not-run", exitCode: null, head: null } });
    expect(status.headline).toBe("Ready for review");
    expect(status.sentence).toBe("The report is ready to read. Read it, then mark it complete.");
    expect(row(status, "checks")).toBeUndefined();
  });
});

describe("severity", () => {
  const stages: TaskStage[] = ["queued", "planning", "needs-you", "building", "checking", "finished", "complete", "failed", "stopped"];
  const checks: (ChecksFact | null)[] = [null, passed, failed, { status: "running", exitCode: null, head: null }, { status: "not-run", exitCode: null, head: null }, { status: "unavailable", exitCode: null, head: null }];
  const prs: (PullRequestFact | null)[] = [null, pr("none"), pr("opening"), pr("open"), pr("open", "running"), pr("open", "passing"), pr("open", "failing"), pr("merged"), pr("closed"), pr("failed")];
  const requirements = [null, { met: 3, total: 3, yours: 0 }, { met: 1, total: 3, yours: 1 }, { met: 1, total: 3, yours: 0 }];
  const evidence = [null, { shortened: 0, missing: 0, damaged: 0 }, { shortened: 2, missing: 0, damaged: 0 }, { shortened: 0, missing: 1, damaged: 0 }, { shortened: 0, missing: 0, damaged: 1 }];

  test("every combination: one of the eight headlines, and red only when the headline is Failed", () => {
    let count = 0;
    for (const stage of stages) for (const check of checks) for (const pull of prs) for (const req of requirements) for (const saved of evidence) {
      const facts: TaskStatusFacts = { stage, checks: check, pullRequest: pull, requirements: req, evidence: saved };
      const status = taskStatusOf(facts);
      count += 1;
      expect(HEADLINES).toContain(status.headline);
      expect(status.tone === "danger", JSON.stringify(facts)).toBe(status.headline === "Failed");
      if (status.headline !== "Failed") {
        expect(status.details.every(one => one.mark !== "failed"), JSON.stringify(facts)).toBe(true);
        expect(htmlString(statusDetailsHtml(status))).not.toContain("status-detail--failed");
      }
      // A detail problem that doesn't undo the outcome never changes the headline.
      expect(status.headline).toBe(headlineOf(facts));
      // Every amber note carries exactly one action.
      for (const one of status.details.filter(detail => detail.mark === "note")) expect(one.action, JSON.stringify(facts)).not.toBeNull();
    }
    expect(count).toBe(stages.length * checks.length * prs.length * requirements.length * evidence.length);
  });

  test("a pull request, a shortened output or a missing file never repaints a finished result", () => {
    for (const pull of [pr("failed"), pr("open", "failing"), pr("closed")]) {
      expect(taskStatusOf({ stage: "complete", checks: passed, pullRequest: pull }).headline).toBe("Complete");
      expect(taskStatusOf({ stage: "finished", checks: passed, pullRequest: pull }).headline).toBe("Ready for review");
    }
    expect(taskStatusOf({ stage: "finished", checks: passed, evidence: { shortened: 3, missing: 1, damaged: 1 } }).headline).toBe("Ready for review");
  });
});

describe("reading the existing projections", () => {
  const dispatchCodes = ["updating", "complete", "needs-verification", "proof-refuted", "review-pending", "reviewing", "review-failed", "review-exhausted", "cancelled", "failed",
    "running", "vanished-run", "retry-scheduled", "waiting-decision", "waiting-incident", "held", "stopped", "waiting-dependency", "terminal-dependency", "needs-project",
    "needs-scope", "needs-agent-profile", "needs-approval", "missing-requirement", "no-worker-registered", "no-worker-online", "worker-at-capacity", "provider-quota",
    "signed-out", "planning-ready", "planner-source", "scouting-ready", "ready"];
  const indexCodes = ["history-problem", "earlier-active", "ready-to-check", "complete", "cancelled", "running", "waiting-decision", "decision-queue", "result-needs-attention",
    "process-needs-attention", "failed", "vanished-run", "stopping", "stopped", "held", "waiting-incident", "terminal-dependency", "waiting-dependency", "needs-project",
    "needs-scope", "invalid-scope", "needs-agent-profile", "needs-approval", "missing-requirement", "no-worker-registered", "no-worker-online", "worker-at-capacity",
    "signed-out", "retry-scheduled", "updating", "planning-ready", "scouting-ready", "queued"];

  test("every dispatch and Tasks-list code has one of the eight headlines", () => {
    for (const code of [...dispatchCodes, ...indexCodes]) {
      for (const needsPerson of [true, false]) {
        const { stage, need } = stageOfCode(code, { needsPerson });
        expect(HEADLINES, code).toContain(taskStatusOf({ stage, ...(need === undefined ? {} : { need }) }).headline);
      }
    }
    expect(stageOfCode("queued").stage).toBe("queued");
    expect(stageOfCode("worker-at-capacity").stage).toBe("queued");
    expect(stageOfCode("needs-approval")).toEqual({ stage: "needs-you", need: "approval" });
    expect(stageOfCode("failed").stage).toBe("failed");
    expect(stageOfCode("cancelled").stage).toBe("stopped");
    expect(stageOfCode("held", { operatorHold: true }).stage).toBe("stopped");
    expect(stageOfCode("held", { operatorHold: false }).stage).toBe("needs-you");
    expect(stageOfCode("ready-to-check").stage).toBe("finished");
    expect(stageOfCode("no-worker-online", { needsPerson: true }).stage).toBe("needs-you");
  });

  test("a dispatch diagnosis on the phone: done is Complete only once marked; a failed check is Failed", () => {
    expect(stageOfDispatch({ code: "complete", condition: "terminal", action: "open-result" }, { completed: false }).stage).toBe("finished");
    expect(stageOfDispatch({ code: "complete", condition: "terminal", action: "open-result" }, { completed: true }).stage).toBe("complete");
    expect(stageOfDispatch({ code: "proof-refuted", condition: "waiting", action: "open-result", detail: "The repository's approved check failed against this build (exit 1)." }).stage).toBe("failed");
    expect(stageOfDispatch({ code: "running", condition: "running", action: null, role: "planner" }).stage).toBe("planning");
  });

  test("a publication row reads as its pull request", () => {
    expect(pullRequestFactOf(null)).toBeNull();
    expect(pullRequestFactOf({ state: "failed", prNumber: null, prUrl: null, remoteState: null, lastError: "rejected", githubRepo: "acme/shop", base: "main", head: "toolroll/fix" }))
      .toMatchObject({ state: "failed", error: "rejected", compareUrl: "https://github.com/acme/shop/compare/main...toolroll/fix?expand=1" });
    expect(pullRequestFactOf({ state: "opened", prNumber: 12, prUrl: "https://github.com/acme/shop/pull/12", remoteState: "MERGED" })!.state).toBe("merged");
    expect(pullRequestFactOf({ state: "opened", prNumber: 12, prUrl: "https://github.com/acme/shop/pull/12", remoteState: null, lastCheckState: "running" })).toMatchObject({ state: "open", ci: "running" });
    // A head that could escape the compare path is never linked.
    expect(pullRequestFactOf({ state: "failed", prUrl: null, remoteState: null, githubRepo: "acme/shop", base: "main", head: "../evil" })!.compareUrl).toBeNull();
  });

  const snapshot = (over: Partial<AssignmentSnapshot>): AssignmentSnapshot => ({
    version: 1, rootId: "fix", activeTaskId: "fix", repo: "/repo", title: "Fix", state: "complete", detail: "Handled by sam. Checks passed. Publication and deployment are separate.",
    primaryAction: { code: "open-result", label: "Open result", target: { taskId: "fix", runId: 4, decisionId: null }, access: "read", retry: "read-again" },
    attention: [], attempts: [], owner: null,
    receipt: { digest: "d".repeat(64), rootId: "fix", taskId: "fix", runId: 4, base: "1".repeat(40), head: HEAD, scopeDigest: null, proof: null, completionKind: "checked-build", proofAcceptance: null,
      checks: { status: "passed", exitCode: 0, command: "npm test", logArtifactId: 2, detail: "Checks passed." }, artifacts: [{ id: 2, kind: "check-log", sha256: "e".repeat(64), bytes: 10, complete: true }],
      caveats: [], agentReport: null, evidence: "recorded" },
    completion: { actor: "operator:sam", at: "2026-10-01T00:00:00.000Z", digest: "d".repeat(64) }, handoff: null,
    publication: { state: "failed", prUrl: null, remoteState: null }, deployment: { status: "not-recorded" }, ...over,
  } as AssignmentSnapshot);

  test("an assignment: the reported case reads Complete with one amber row", () => {
    const status = taskStatusOf(assignmentStatusFacts(snapshot({})));
    expect(status.headline).toBe("Complete");
    expect(status.sentence).toBe("Marked complete by sam.");
    expect(status.details.filter(one => one.mark === "note").map(one => one.key)).toEqual(["pull-request"]);
  });

  test("an assignment: ready with failed checks is Failed; a plan waiting is Needs you; cancelled is Stopped", () => {
    const failing = snapshot({ state: "ready-to-check", completion: null, publication: null,
      receipt: { ...snapshot({}).receipt!, checks: { status: "failed", exitCode: 1, command: "npm test", logArtifactId: 2, detail: "Checks failed (exit 1)." } } });
    expect(taskStatusOf(assignmentStatusFacts(failing)).headline).toBe("Failed");
    const approval = snapshot({ state: "needs-decision", receipt: null, completion: null, publication: null, detail: "Review and sign the current scope before a worker can claim it.",
      primaryAction: { code: "approve-scope", label: "Review plan", target: { taskId: "fix", runId: null, decisionId: null }, access: "operator-control", retry: "refresh-before-acting" } });
    expect(taskStatusOf(assignmentStatusFacts(approval))).toMatchObject({ headline: "Needs you", sentence: "Review the plan and approve it to start." });
    expect(taskStatusOf(assignmentStatusFacts(snapshot({ state: "cancelled", completion: null }))).headline).toBe("Stopped");
    const failedTask = snapshot({ state: "needs-decision", receipt: null, completion: null, publication: null, detail: "The last attempt stopped; review its incident, then retry it." });
    expect(taskStatusOf(assignmentStatusFacts(failedTask, { work: { token: "failed", detail: "The last attempt stopped; review its incident, then retry it." } })).headline).toBe("Failed");
    const working = snapshot({ state: "working", receipt: null, completion: null, publication: null, detail: "Working" });
    expect(taskStatusOf(assignmentStatusFacts(working, { work: { token: "signed-out", detail: "Claude needs you to sign in again." } })).headline).toBe("Needs you");
    expect(taskStatusOf(assignmentStatusFacts(working, { work: { token: "queued" } })).headline).toBe("Queued");
    expect(taskStatusOf(assignmentStatusFacts(working, { work: { token: "running" }, planning: true })).headline).toBe("Planning");
  });
});

describe("requirements while the report is refuted", () => {
  test("read Unverified, never a green tick, whatever the report marked met", () => {
    const requirements = unverifiedWhenRefuted({ met: 2, total: 2, yours: 0 }, "refuted");
    const row = taskStatusOf({ stage: "needs-you", need: "review-result", requirements }).details.find(one => one.key === "requirements");
    expect(row).toMatchObject({ text: "Unverified", mark: "none" });
    expect(unverifiedWhenRefuted({ met: 2, total: 2, yours: 0 }, "verified")).toEqual({ met: 2, total: 2, yours: 0 });
    expect(taskStatusOf({ stage: "finished", requirements: { met: 2, total: 2, yours: 0 } }).details.find(one => one.key === "requirements")).toMatchObject({ text: "2 of 2 met", mark: "ok" });
  });

  test("a failed result says how many it missed, refuted or not", () => {
    const missed = unverifiedWhenRefuted(requirementsOf([{ state: "failed" }, { state: "pass" }]), "refuted");
    expect(missed).toEqual({ met: 1, total: 2, yours: 0, missed: 1, unverified: true });
    expect(taskStatusOf({ stage: "failed", requirements: missed }).details.find(one => one.key === "requirements")).toMatchObject({ text: "1 missed", mark: "failed" });
    // Anywhere else, the refuted reading stands.
    expect(taskStatusOf({ stage: "needs-you", need: "review-result", requirements: missed }).details.find(one => one.key === "requirements")).toMatchObject({ text: "Unverified" });
  });
});

describe("checks in the demo", () => {
  test("a Checks row that would run one says the demo can't; a recorded result stays as it is", () => {
    const notRun = taskStatusOf({ stage: "failed", checks: { status: "not-run", exitCode: null, head: HEAD }, links: { runChecks: "/r/7/checks" } });
    expect(demoChecksOf(notRun).details.find(one => one.key === "checks")).toMatchObject({ text: DEMO_CHECKS, action: null, href: null });
    const ran = taskStatusOf({ stage: "failed", checks: failed });
    expect(demoChecksOf(ran).details).toEqual(ran.details);
  });
});
