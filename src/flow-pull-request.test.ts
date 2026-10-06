/**
 * A flow's Pull request zone, against a scripted git and gh (never the network): a card's built result opens a PR
 * under the project's pull request setup, green CI moves it on (merging first only after a person approved it),
 * red CI takes the failure path with the failing check named, back to the build as a revision. The Issues to PRs
 * template validates, and no flow can merge without a decision before it.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover, approve, propose } from "./scope.js";
import { storeEvidence } from "./evidence.js";
import { sealVerificationReceipt } from "./verification-evidence.js";
import { observeChecks, publishPass, type PublishExec } from "./publish.js";
import { register } from "./runner.js";
import { checkPublishing, followPullRequests, pullRequestViewOf, savePublishing } from "./pull-request-flow.js";
import { FLOW_TEMPLATES, flowFromSteps, flowTerms, validateFlowDefinition, type FlowDefinition } from "./flows.js";
import { decideFlowCard } from "./flow-engine.js";
import { runFlowSteps, type StepIo } from "./flow-steps.js";
import type { Runner } from "./backend.js";

const T0 = new Date("2026-09-30T09:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const REPO = "/projects/shop";
const HEAD = "a".repeat(40);
const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };

type Answer = { code?: number; stdout?: string; stderr?: string };
function scripted(answers: [string, Answer | ((args: string[]) => Answer)][]) {
  const calls: string[][] = [];
  const exec: PublishExec = async (file, args) => {
    const line = [file, ...args];
    calls.push(line);
    const found = answers.find(([prefix]) => line.join(" ").startsWith(prefix));
    return { ...OK, ...(found === undefined ? {} : typeof found[1] === "function" ? found[1]([...args]) : found[1]) };
  };
  return { exec, calls, ran: (prefix: string) => calls.filter(call => call.join(" ").startsWith(prefix)) };
}
const rollup = (conclusion: "SUCCESS" | "FAILURE", name = "unit tests") =>
  [{ __typename: "CheckRun", name, status: "COMPLETED", conclusion, detailsUrl: "https://github.com/alex/shop/actions/runs/77/job/991" }];
const prView = (conclusion: "SUCCESS" | "FAILURE") => ({ stdout: JSON.stringify({ statusCheckRollup: rollup(conclusion), headRefOid: HEAD, state: "OPEN", isDraft: false, mergeCommit: null }) });

describe("the Pull request zone", () => {
  let store: Store;
  let dir: string;
  let token: string;

  /** A finished, checked result on its own branch — Ready, with its exact receipt. */
  const readyResult = (taskId: string): number => {
    store.createTask({ id: taskId, title: "Fix the checkout total" }, T0);
    store.placeTask(store.refFor("built-in", taskId).id, REPO, {}, T0);
    propose(store, { taskId, goal: "Fix the checkout total", touches: ["src/total.ts"], acceptance: [{ id: "c1", statement: "Totals add up.", how: null, evidence: ["check"] }], now: T0 });
    const approved = approve(store, taskId, "alex", T0, store.getScope(taskId)!.digest, token);
    if (!approved.ok) throw new Error(JSON.stringify(approved));
    const ref = store.lookupRef(taskId)!.id;
    const authority = store.routeAuthorityFor(ref, "builder");
    if (!authority?.ok) throw new Error("route fixture");
    const runId = store.startRun({ taskRef: ref, leaseId: `l-${taskId}`, runner: "worker-1", branch: `toolroll/${taskId}`, worktree: `/pool/${taskId}`, route: authority.stamp, now: T0 });
    store.stampRun(runId, { scopeDigest: store.getScope(taskId)!.digest, baseRevision: "b".repeat(40) });
    store.recordOutcomeFacts(runId, { headRevision: HEAD, handoff: "Totals now include tax." });
    store.finishRun(runId, { outcome: "built", committed: true, now: T0 });
    store.setTaskState(taskId, "done", T0);
    storeEvidence(store, dir, runId, "terminal-diff", "diff.patch", Buffer.from("--- a/src/total.ts\n+++ b/src/total.ts\n"), "git diff (exit 0)", T0, { captureStatus: "ok" });
    storeEvidence(store, dir, runId, "check-log", "checks.txt", Buffer.from("1 test passed"), "npm test", T0, { captureStatus: "ok" });
    sealVerificationReceipt(store, dir, runId, HEAD, store.liveVerifyCommand(REPO)!, { configured: true, ran: true, exitCode: 0 }, T0);
    return runId;
  };

  beforeEach(async () => {
    store = openStore(":memory:");
    dir = mkdtempSync(join(tmpdir(), "so-flow-pr-"));
    const alex = addApprover(store, "alex", T0);
    if (!alex.ok) throw new Error("approver");
    token = alex.token;
    register(store, { name: "worker-1", host: "test", capacity: 4, repos: [REPO], now: T0, newToken: () => "tok-worker-1" });
    for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "alex", T0);
    store.setVerifyCommand({ repo: REPO, command: "npm test", timeoutMs: 300_000, approvedBy: "alex" }, T0);
    const setup = scripted([
      ["git remote get-url origin", { stdout: "git@github.com:alex/shop.git\n" }], ["gh auth status", {}],
      ["gh repo view alex/shop", { stdout: JSON.stringify({ nameWithOwner: "alex/shop", defaultBranchRef: { name: "main" }, viewerPermission: "WRITE" }) }], ["gh api user", { stdout: "alex\n" }],
    ]);
    const checked = await checkPublishing(REPO, { exec: setup.exec });
    if (!checked.ok) throw new Error(checked.message);
    savePublishing(store, checked.plan, "alex", {}, T0);
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  const io = (gh: PublishExec): StepIo => ({ gh: gh as Runner, git: vi.fn<Runner>(), shell: vi.fn<Runner>(), fetch: vi.fn() as unknown as typeof fetch, dir, scratch: join(dir, "scratch"), base: "main", evidenceRoot: dir });
  const issuesToPrs = (merge: boolean): FlowDefinition => {
    const template = structuredClone(FLOW_TEMPLATES.find(one => one.id === "issues-to-prs")!.definition);
    if (merge) template.stages.find(one => one.id === "pull-request")!.merge = "squash";
    return validateFlowDefinition(template);
  };
  /** A card whose build is done, waiting at the flow's decision; then a person approves it into the Pull request zone. */
  const approvedCard = (definition: FlowDefinition, taskId: string) => {
    const flow = store.createFlow({ repo: REPO, name: "Issues to PRs", definitionJson: JSON.stringify(definition), by: "alex" }, T0);
    const card = store.addFlowCard({ flow, title: "Checkout total is wrong", description: "Tax is missing.", stage: "build", by: "alex" }, T0);
    store.setFlowCardOwner(card, "alex", "alex", T0);
    const runId = readyResult(taskId);
    store.updateFlowCard(card, { task: taskId, primaryTask: taskId }, T0);
    store.moveFlowCard(card, { to: "approve", outcome: "ok", actor: "flow" }, at(1));
    expect(decideFlowCard(store, { card, decision: "approve", note: null, actor: "alex", repos: [REPO], evidenceRoot: dir }, at(2))).toMatchObject({ ok: true });
    expect(store.getFlowCard(card)).toMatchObject({ stage: "pull-request" });
    return { flow, card, runId };
  };
  /** The publisher pushes and opens PR #12, and CI is observed as `state`. */
  const openAndObserve = async (state: "SUCCESS" | "FAILURE", minute: number) => {
    const publisher = scripted([["gh pr list", { stdout: "[]" }], ["gh pr create", { stdout: "https://github.com/alex/shop/pull/12\n" }]]);
    expect(await publishPass(store, { repo: REPO, exec: publisher.exec, clock: () => at(minute), evidenceRoot: dir })).toMatchObject({ pushed: 1, opened: 1 });
    const ci = scripted([["gh pr view", prView(state)]]);
    const seen = await observeChecks(store, { exec: ci.exec, clock: () => at(minute + 1) });
    // Complete's follower leaves a flow's pull request to its zone: no revision, no Ready to merge from it.
    expect(await followPullRequests(store, seen.seen, { evidenceRoot: dir, exec: ci.exec, clock: () => at(minute + 1) })).toMatchObject({ revisions: 0, ready: 0 });
  };

  test("c1: a card goes through Pull request to green: the PR opens for its result, waits for CI, merges after the approval and moves on", async () => {
    const { card, runId } = approvedCard(issuesToPrs(true), "fix-total");
    const quiet = scripted([]);
    // First pass: the PR is owed for the result's exact commit, under the project's grant.
    await runFlowSteps(store, REPO, at(3), io(quiet.exec));
    expect(store.pendingPublications()).toMatchObject([{ run: runId, headSha: HEAD, head: "toolroll/fix-total", base: "main", githubRepo: "alex/shop" }]);
    expect(store.getFlowCard(card)).toMatchObject({ stage: "pull-request", waiting: "Opening the pull request…" });
    // A second pass owes nothing more.
    await runFlowSteps(store, REPO, at(4), io(quiet.exec));
    expect(store.pendingPublications()).toHaveLength(1);

    await openAndObserve("SUCCESS", 5);
    // The task page shows the PR the flow opened.
    expect(pullRequestViewOf(store, runId)).toMatchObject({ prNumber: 12, state: "ready" });

    let merged = false;
    const gh = scripted([
      ["gh pr merge", () => { merged = true; return {}; }],
      ["gh pr view", () => ({ stdout: JSON.stringify(merged
        ? { state: "MERGED", isDraft: false, headRefOid: HEAD, statusCheckRollup: rollup("SUCCESS"), mergeCommit: { oid: "c".repeat(40) } }
        : { state: "OPEN", isDraft: false, headRefOid: HEAD, statusCheckRollup: rollup("SUCCESS"), mergeCommit: null }) })],
    ]);
    await runFlowSteps(store, REPO, at(8), io(gh.exec));
    expect(gh.ran("gh pr merge")).toEqual([["gh", "pr", "merge", "12", "--repo", "alex/shop", "--squash", "--match-head-commit", HEAD, "--delete-branch"]]);
    expect(store.getFlowCard(card)).toMatchObject({ stage: "update-issue", outputs: { "pull-request": "Merged: https://github.com/alex/shop/pull/12" } });
    expect(pullRequestViewOf(store, runId)).toMatchObject({ state: "merged", mergeCommit: "c".repeat(40) });
    expect(store.handle.prepare("SELECT merged_by FROM pull_request_follow").get()).toEqual({ merged_by: "alex (approved in Issues to PRs)" });
  });

  test("c1: without Merge, green moves the card on with the PR's link for the issue comment", async () => {
    const { card } = approvedCard(issuesToPrs(false), "fix-total");
    await runFlowSteps(store, REPO, at(3), io(scripted([]).exec));
    await openAndObserve("SUCCESS", 5);
    const gh = scripted([]);
    await runFlowSteps(store, REPO, at(8), io(gh.exec));
    expect(gh.calls).toEqual([]);
    expect(store.getFlowCard(card)).toMatchObject({ stage: "update-issue", outputs: { "pull-request": "Pull request: https://github.com/alex/shop/pull/12 (checks passed)" } });
  });

  test("c1: a card goes through Pull request to red: the failing check is named and it goes back to Build as a revision", async () => {
    const { card } = approvedCard(issuesToPrs(true), "fix-total");
    await runFlowSteps(store, REPO, at(3), io(scripted([]).exec));
    // Before CI reports, it waits.
    const publisher = scripted([["gh pr list", { stdout: "[]" }], ["gh pr create", { stdout: "https://github.com/alex/shop/pull/12\n" }]]);
    await publishPass(store, { repo: REPO, exec: publisher.exec, clock: () => at(4), evidenceRoot: dir });
    await runFlowSteps(store, REPO, at(4), io(scripted([]).exec));
    expect(store.getFlowCard(card)).toMatchObject({ stage: "pull-request", waiting: "Waiting for CI on PR #12." });

    const ci = scripted([["gh pr view", prView("FAILURE")]]);
    await observeChecks(store, { exec: ci.exec, clock: () => at(6) });
    const gh = scripted([["gh pr view", prView("FAILURE")], ["gh run view", { stdout: "unit\tRun npm test\t2026-09-30T09:01:00.0000000Z expected 107 to be 100\n" }]]);
    await runFlowSteps(store, REPO, at(8), io(gh.exec));
    expect(gh.ran("gh pr merge")).toEqual([]);
    const after = store.getFlowCard(card)!;
    expect(after).toMatchObject({ stage: "build", note: "CI check “unit tests” failed on PR #12.", outputs: { "pull-request": "CI check “unit tests” failed on PR #12." } });
    // The build zone follows a revision of the same work, carrying the failure.
    expect(after.task).not.toBeNull();
    expect(after.task).not.toBe("fix-total");
    expect(store.revisionSourceOf(store.lookupRef(after.task!)!.id)).not.toBeNull();
    expect(store.listNotifications("all").some(one => one.subject === "Issues to PRs: Pull request didn't pass for “Checkout total is wrong”")).toBe(true);
  });

  test("c1: set up by publish setup, with another project's watch publishing too: one PR, the card waits on CI, then moves on", async () => {
    const { card, runId } = approvedCard(issuesToPrs(false), "fix-total");
    const quiet = scripted([]);
    await runFlowSteps(store, REPO, at(3), io(quiet.exec));
    // Another project's watch (no grant of its own) runs its passes over the same database: it leaves this
    // project's publication alone — no "no live grant" errors counted against it, no giving up.
    const other = scripted([]);
    for (let pass = 0; pass < 8; pass++) await publishPass(store, { repo: "/projects/other", exec: other.exec, clock: () => at(4), evidenceRoot: dir });
    expect(other.calls).toEqual([]);
    expect(store.pendingPublications()).toMatchObject([{ run: runId, attempts: 0, lastError: null, state: "intended" }]);
    await runFlowSteps(store, REPO, at(4), io(quiet.exec));
    expect(store.getFlowCard(card)).toMatchObject({ stage: "pull-request", waiting: "Opening the pull request…" });

    const publisher = scripted([["gh pr list", { stdout: "[]" }], ["gh pr create", { stdout: "https://github.com/alex/shop/pull/12\n" }]]);
    expect(await publishPass(store, { repo: REPO, exec: publisher.exec, clock: () => at(5), evidenceRoot: dir })).toMatchObject({ pushed: 1, opened: 1, failed: 0 });
    expect(publisher.ran("git push")).toHaveLength(1);
    expect(publisher.ran("gh pr create")).toHaveLength(1);
    await runFlowSteps(store, REPO, at(5), io(quiet.exec));
    expect(store.getFlowCard(card)).toMatchObject({ stage: "pull-request", waiting: "Waiting for CI on PR #12." });

    await observeChecks(store, { exec: scripted([["gh pr view", prView("SUCCESS")]]).exec, clock: () => at(6) });
    await runFlowSteps(store, REPO, at(7), io(quiet.exec));
    expect(store.getFlowCard(card)).toMatchObject({ stage: "update-issue", outputs: { "pull-request": "Pull request: https://github.com/alex/shop/pull/12 (checks passed)" } });
    // One PR, and the card never went back to Build.
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM publication").get()).toEqual({ n: 1 });
    expect(store.flowEvents(card).filter(event => event.toStage === "build" && event.outcome === "fail")).toEqual([]);
  });

  test("c2: a missing grant is one clear waiting state, never a rebuild, and the card carries on once set up", async () => {
    const { card } = approvedCard(issuesToPrs(false), "fix-total");
    store.revokePublicationGrant(REPO, "alex", at(2));
    for (let minute = 3; minute < 8; minute++) await runFlowSteps(store, REPO, at(minute), io(scripted([]).exec));
    const after = store.getFlowCard(card)!;
    expect(after).toMatchObject({ stage: "pull-request", primaryTask: "fix-total",
      waiting: "Pull requests aren't set up for this project. Turn them on in Projects → Pull requests (or run toolroll publish setup); the card carries on by itself." });
    expect(store.flowEvents(card).filter(event => event.outcome === "fail")).toEqual([]);
    expect(store.pendingPublications()).toEqual([]);
    // Told once.
    expect(store.listNotifications("all").filter(one => one.subject.includes("is waiting on you for “Checkout total is wrong”"))).toHaveLength(1);

    const setup = scripted([
      ["git remote get-url origin", { stdout: "git@github.com:alex/shop.git\n" }], ["gh auth status", {}],
      ["gh repo view alex/shop", { stdout: JSON.stringify({ nameWithOwner: "alex/shop", defaultBranchRef: { name: "main" }, viewerPermission: "WRITE" }) }], ["gh api user", { stdout: "alex\n" }],
    ]);
    const checked = await checkPublishing(REPO, { exec: setup.exec });
    if (!checked.ok) throw new Error(checked.message);
    savePublishing(store, checked.plan, "alex", {}, at(8));
    await runFlowSteps(store, REPO, at(9), io(scripted([]).exec));
    expect(store.getFlowCard(card)).toMatchObject({ stage: "pull-request", waiting: "Opening the pull request…" });
    expect(store.pendingPublications()).toHaveLength(1);
  });

  test("c2: a publication given up on whose PR opened anyway is adopted and waits on CI; one with no PR waits, never rebuilds", async () => {
    const { card, runId } = approvedCard(issuesToPrs(false), "fix-total");
    await runFlowSteps(store, REPO, at(3), io(scripted([]).exec));
    const id = store.publicationForRun(runId)!.id;
    store.recordPublicationError(id, "no live publication grant — nothing may be pushed", at(3));
    store.failPublication(id, at(3));
    const gh = scripted([["gh pr list", { stdout: JSON.stringify([{ number: 3, url: "https://github.com/alex/shop/pull/3", headRefOid: HEAD }]) }]]);
    await runFlowSteps(store, REPO, at(4), io(gh.exec));
    expect(gh.ran("gh pr list")).toEqual([["gh", "pr", "list", "--repo", "alex/shop", "--head", "toolroll/fix-total", "--base", "main", "--state", "all", "--json", "number,url,headRefOid"]]);
    expect(store.publicationForRun(runId)).toMatchObject({ state: "opened", prNumber: 3 });
    expect(store.getFlowCard(card)).toMatchObject({ stage: "pull-request", waiting: "Waiting for CI on PR #3." });

    // Gave up, and no PR carries this commit: a waiting state saying what to do, asked of GitHub once.
    const second = approvedCard(issuesToPrs(false), "fix-tax");
    await runFlowSteps(store, REPO, at(5), io(scripted([]).exec));
    const other = store.publicationForRun(second.runId)!.id;
    store.recordPublicationError(other, "remote rejected the push", at(5));
    store.failPublication(other, at(5));
    const none = scripted([["gh pr list", { stdout: "[]" }]]);
    await runFlowSteps(store, REPO, at(6), io(none.exec));
    await runFlowSteps(store, REPO, at(7), io(none.exec));
    expect(none.ran("gh pr list")).toHaveLength(1);
    expect(store.getFlowCard(second.card)).toMatchObject({ stage: "pull-request",
      waiting: "Couldn't open the pull request: remote rejected the push. The commit is safe locally. Fix that, then move the card back to Build for a fresh result." });
    expect(store.flowEvents(second.card).filter(event => event.outcome === "fail")).toEqual([]);
  });

  test("c1: no built result takes the failure path saying what to do", async () => {
    const definition = issuesToPrs(false);
    const flow = store.createFlow({ repo: REPO, name: "Issues to PRs", definitionJson: JSON.stringify(definition), by: "alex" }, T0);
    const card = store.addFlowCard({ flow, title: "Nothing built", description: null, stage: "pull-request", by: "alex" }, T0);
    await runFlowSteps(store, REPO, at(1), io(scripted([]).exec));
    expect(store.getFlowCard(card)).toMatchObject({ stage: "build", note: "There's no built result on this card to open a pull request for." });
    expect(store.pendingPublications()).toEqual([]);
  });

  test("c2: the Issues to PRs template validates, starts from labelled issues, and never merges without an approval zone before it", () => {
    const template = FLOW_TEMPLATES.find(one => one.id === "issues-to-prs")!;
    const definition = validateFlowDefinition(template.definition);
    expect(definition.stages.map(one => one.kind)).toEqual(["task", "approval", "pull-request", "update", "done"]);
    expect(template.trigger).toEqual({ kind: "github", watch: "issues", label: "toolroll" });
    expect(definition.stages.find(one => one.id === "pull-request")).toMatchObject({ next: "update-issue", onFail: "build" });
    expect(definition.stages.find(one => one.id === "pull-request")!.merge).toBeUndefined();
    // Merge on: fine, because Approve comes before it on every path.
    expect(issuesToPrs(true).stages.find(one => one.id === "pull-request")!.merge).toBe("squash");
    expect(flowTerms(issuesToPrs(true), null).join("\n")).toContain("merges it (squash) and deletes its branch, only when a person approved it at Approve since it was built.");

    // No decision before a merging zone: refused, whether drawn or listed as steps.
    expect(() => flowFromSteps([{ title: "Build", kind: "task" }, { title: "Pull request", kind: "pull-request", merge: true }])).toThrow("steps[1].merge: a “Person decides” zone must come before it on every path");
    // A path around the decision (the build's failure path skips it) is refused too.
    expect(() => flowFromSteps([{ title: "Build", kind: "task", ifFails: "Pull request" }, { title: "Approve", kind: "approval" }, { title: "Pull request", kind: "pull-request", merge: "rebase" }])).toThrow(/must come before it on every path/);
    const ok = flowFromSteps([{ title: "Build", kind: "task" }, { title: "Approve", kind: "approval", decider: "owner" }, { title: "Pull request", kind: "pull-request", merge: true }]);
    expect(ok.stages.find(one => one.kind === "pull-request")).toMatchObject({ merge: "squash", onFail: "build" });
    expect(() => validateFlowDefinition({ ...ok, stages: ok.stages.map(one => one.kind === "pull-request" ? { ...one, merge: "fast-forward" } : one) })).toThrow('stages[2].merge: must be one of "squash", "merge", "rebase"');
  });

  test("c2: a card moved into a merging zone by hand, with no approval since its build, is never merged", async () => {
    const definition = issuesToPrs(true);
    const flow = store.createFlow({ repo: REPO, name: "Issues to PRs", definitionJson: JSON.stringify(definition), by: "alex" }, T0);
    const card = store.addFlowCard({ flow, title: "Skip the review", description: null, stage: "build", by: "alex" }, T0);
    readyResult("skip-review");
    store.updateFlowCard(card, { task: "skip-review", primaryTask: "skip-review" }, T0);
    store.moveFlowCard(card, { to: "pull-request", outcome: "moved", actor: "alex" }, at(1));
    await runFlowSteps(store, REPO, at(2), io(scripted([]).exec));
    await openAndObserve("SUCCESS", 3);
    const gh = scripted([["gh pr view", prView("SUCCESS")]]);
    await runFlowSteps(store, REPO, at(6), io(gh.exec));
    expect(gh.ran("gh pr merge")).toEqual([]);
    expect(store.getFlowCard(card)).toMatchObject({ stage: "pull-request", waiting: expect.stringContaining("no person approved this card since it was built, so it wasn't merged") });
  });
});
