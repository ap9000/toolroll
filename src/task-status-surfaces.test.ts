/** Every surface reads the same headline from the shared task status: the task
 * page, the build/result page, the Chat result, Crew, the Tasks list, the chat
 * card (Telegram, Slack, Discord and Teams send the same card) and `toolroll
 * status`. Red appears only when the headline is Failed. Real HTTP against an
 * ephemeral port over a seeded throwaway store; no GitHub, no model. */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { register } from "./runner.js";
import { acquire } from "./claim.js";
import { addApprover, approve, propose } from "./scope.js";
import { storeEvidence } from "./evidence.js";
import { sealVerificationReceipt } from "./verification-evidence.js";
import { createDecisionServer } from "./serve.js";
import { savePublishing, completeAndOpenPullRequest, followPullRequests } from "./pull-request-flow.js";
import { verifyApproverByPassword } from "./principal.js";
import { assignmentOf, checkAssignmentAsOperator } from "./assignment.js";
import { telegramProgressCard } from "./telegram-progress.js";
import { installationStatus, taskWaitSnapshot } from "./lead-status.js";
import { phoneStatus, phoneTask, phoneTaskChoices } from "./telegram-status.js";
import { workIndexPage } from "./work-index.js";
import { HEADLINES } from "./task-status.js";
import { assignmentTaskStatusOf } from "./assignment-presentation.js";
import { taskWorkSummaryOf } from "./work-summary.js";
import type { BrowserWorkspace } from "./browser-workspace.js";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const REPO = "/repos/storefront";
let store: Store;
let server: Server;
let base: string;
let root: string;
let password: string;
let cookie: string;
const runs: Record<string, number> = {};

function workspaceOf(html: string): BrowserWorkspace {
  const json = /<script type="application\/json" id="standing-orders-workspace-data"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
  expect(json).toBeDefined();
  return JSON.parse(json!);
}
const page = async (path: string) => (await fetch(`${base}${path}`, { headers: { cookie } })).text();

function filed(id: string, title: string, at: Date, approved = true): number {
  store.createTask({ id, title }, at);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, REPO, {}, at);
  const proposed = propose(store, { taskId: id, goal: title, touches: ["src/"], acceptance: [{ id: "c1", statement: title, how: null, evidence: ["check"] }], now: at });
  if (approved) {
    const ok = approve(store, id, "sam", at, proposed.digest, password);
    if (!ok.ok) throw new Error(ok.reason);
  }
  return ref;
}

function built(id: string, title: string, at: Date, exitCode = 0): number {
  const ref = filed(id, title, at);
  const authority = store.routeAuthorityFor(ref, "builder");
  if (!authority?.ok) throw new Error("route");
  const run = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "builder-1", branch: `toolroll/${id}`, worktree: `/pool/${id}`, route: authority.stamp, now: at });
  const head = (run + 10).toString(16).padStart(2, "0").repeat(20);
  store.stampRun(run, { scopeDigest: store.getScope(id)!.digest, baseRevision: "1".repeat(40) });
  store.recordOutcomeFacts(run, { headRevision: head, handoff: `${title}, with a regression test.` });
  store.finishRun(run, { outcome: "built", committed: true, now: at });
  store.setTaskState(id, "done", at);
  const failing = exitCode !== 0;
  store.saveProofVerdict(run, failing ? "refuted" : "verified", failing ? [`the repository's approved verification command exited ${exitCode}`] : [], at,
    [{ id: "c1", statement: title, requiredEvidence: ["check"], state: failing ? "fail" : "pass", detail: [], answered: [], review: null }] as never, failing ? "refuted" : "verified");
  storeEvidence(store, root, run, "terminal-diff", "diff.patch", Buffer.from(`diff --git a/src/${id}.ts b/src/${id}.ts\n--- a/src/${id}.ts\n+++ b/src/${id}.ts\n@@ -1 +1 @@\n-a\n+b\n`), "git diff (exit 0)", at, { captureStatus: "ok" });
  storeEvidence(store, root, run, "check-log", "checks.txt", Buffer.from(failing ? "1 failed\n" : "612 passed\n"), "npm test", at, { captureStatus: "ok" });
  sealVerificationReceipt(store, root, run, head, store.liveVerifyCommand(REPO)!, { configured: true, ran: true, exitCode }, at);
  runs[id] = run;
  return run;
}

function completeWithPullRequest(id: string, at: Date) {
  const who = verifyApproverByPassword(store, "sam", password, [REPO]);
  if (!who.ok) throw new Error("who");
  const assignment = assignmentOf(store, id, at, { principal: "operator", repos: [REPO] }, root)!;
  const opened = completeAndOpenPullRequest(store, { taskId: id, digest: assignment.receipt!.digest, runId: runs[id]!, who: who.who, root }, at);
  if (!opened.ok) throw new Error(`complete ${id}`);
  return opened.publication;
}

beforeAll(async () => {
  store = openStore(":memory:");
  root = mkdtempSync(join(tmpdir(), "task-status-surfaces-"));
  register(store, { name: "builder-1", host: "test", capacity: 4, repos: [REPO], now: NOW, newToken: () => "tok-builder-1" });
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", ago(600));
  const sam = addApprover(store, "sam", ago(600));
  if (!sam.ok) throw new Error("approver");
  password = sam.token;
  store.setVerifyCommand({ repo: REPO, command: "npm test", timeoutMs: 300_000, approvedBy: "sam" }, ago(600));
  savePublishing(store, { repo: REPO, githubRepo: "sam-shop/storefront", remote: "origin", base: "main", account: "sam" }, "sam", {}, ago(600));

  // The reported case: checks passed, marked complete, the pull request couldn't open.
  built("fix-checkout-tax", "Stop charging tax twice at checkout", ago(95));
  const failedPublication = completeWithPullRequest("fix-checkout-tax", ago(80));
  store.recordPublicationError(failedPublication.id, "remote: GH006: Protected branch update failed.", ago(79));
  store.failPublication(failedPublication.id, ago(78));
  built("search-typo-tolerance", "Let search tolerate one typo", ago(40));
  built("coupon-stacking", "Stop coupons stacking on sale items", ago(60), 1);
  built("faster-product-images", "Serve smaller product images", ago(300));
  const merged = completeWithPullRequest("faster-product-images", ago(280));
  store.markPublicationPushed(merged.id, ago(279));
  store.markPublicationOpened(merged.id, 41, "https://github.com/sam-shop/storefront/pull/41", ago(279));
  store.recordPublicationRemoteState(merged.id, "MERGED", ago(200));
  await followPullRequests(store, [{ publication: store.publicationForRun(runs["faster-product-images"]!)!, headOid: "", state: "passing", remoteState: "MERGED", rollup: [], mergeCommit: "9".repeat(40) } as never], { evidenceRoot: root, clock: () => ago(200) });
  {
    const ref = filed("order-history-export", "Export order history as CSV", ago(25));
    const claim = acquire(store, ref, "builder-1", { now: ago(12), token: "tok-builder-1", ttlMs: 4 * 3_600_000 });
    if (!claim.ok) throw new Error("claim");
    const authority = store.routeAuthorityFor(ref, "builder");
    if (!authority?.ok) throw new Error("route");
    store.startRun({ taskRef: ref, leaseId: claim.claim.leaseId, runner: "builder-1", branch: "toolroll/order-history-export", worktree: "/pool/x", route: authority.stamp, now: ago(12) });
  }
  // Seen Oct 2: a task and both its revisions, the family marked complete.
  {
    built("review-once", "Review each build once", ago(250));
    const revise = (id: string, source: string, at: Date) => {
      const brief = storeEvidence(store, root, runs[source]!, "revision-brief", `${id}.json`, Buffer.from(`{"revises":"${source}"}`), "revision brief", at, { captureStatus: "ok" });
      built(id, "Review each build once", at);
      store.markRevision(store.lookupRef(id)!.id, source, brief);
    };
    revise("review-once-2", "review-once", ago(240));
    revise("review-once-3", "review-once-2", ago(230));
    const who = verifyApproverByPassword(store, "sam", password, [REPO]);
    if (!who.ok) throw new Error("who");
    const family = assignmentOf(store, "review-once", ago(220), { principal: "operator", repos: [REPO] }, root)!;
    if (family.activeTaskId !== "review-once-3") throw new Error("family");
    if (!checkAssignmentAsOperator(store, "review-once", family.receipt!.digest, who.who, ago(220), root).ok) throw new Error("complete review-once");
  }
  filed("gift-card-balance", "Show gift card balance at checkout", ago(18), false);
  filed("wishlist-share-link", "Share a wishlist by link", ago(5));

  server = createDecisionServer({ store, evidenceRoot: root, repo: REPO, clock: () => NOW, publishExec: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, notFound: false }) });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "sam", token: password }), redirect: "manual" });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
});

afterAll(async () => {
  await new Promise<void>(done => server.close(() => done()));
  store.close();
  rmSync(root, { recursive: true, force: true });
});

const EXPECTED: Record<string, string> = {
  "fix-checkout-tax": "Complete", "search-typo-tolerance": "Ready for review", "coupon-stacking": "Failed", "faster-product-images": "Complete",
  "order-history-export": "Building", "gift-card-balance": "Needs you", "wishlist-share-link": "Queued", "review-once": "Complete",
};

describe("one headline on every surface", () => {
  test("the Tasks list and Crew", async () => {
    const workspace = workspaceOf(await page("/work"));
    const view = workspace.view as Extract<BrowserWorkspace["view"], { kind: "tasks" }>;
    expect(Object.fromEntries(view.rows.map(row => [row.id, row.status.label]))).toEqual(EXPECTED);
    for (const row of view.rows) expect(row.status.tone === "problem", row.id).toBe(row.status.label === "Failed");
    expect(view.tabs.map(tab => tab.label)).toEqual(["All", "Needs you", "Building", "Complete"]);
    for (const item of workspace.crew) {
      expect(HEADLINES, item.id).toContain(item.label);
      expect(item.label).toBe(EXPECTED[item.id]);
      expect(item.tone === "problem").toBe(item.label === "Failed");
    }
  });

  test("the task page: the reported case reads Complete with one amber detail and an action, never red", async () => {
    const html = await page("/t/fix-checkout-tax");
    const view = workspaceOf(html).view as Extract<BrowserWorkspace["view"], { kind: "task" }>;
    expect(view.status!.status.headline).toBe("Complete");
    expect(view.status!.status.details.filter(one => one.mark === "note").map(one => [one.label, one.text, one.action?.label])).toEqual([["Pull request", "Couldn't open", "Open it on GitHub"]]);
    expect(view.status!.status.details.every(one => one.mark !== "failed")).toBe(true);
    // The server-rendered fallback says the same, and never in red.
    const card = /<section class="card assignment-summary"[\s\S]*?<\/section>/.exec(html)![0];
    expect(card).toContain('data-headline="Complete"');
    expect(card).toContain('data-status-detail="pull-request" data-mark="note"');
    expect(html).not.toContain("Publish failed");
    // Said once: the couldn't-open pull request is the row, not a second card.
    expect(html).not.toContain('data-pull-request="failed"');
  });

  test("every task page shows its one headline; red only on Failed", async () => {
    for (const [id, headline] of Object.entries(EXPECTED)) {
      const html = await page(`/t/${id}`);
      const view = workspaceOf(html).view as Extract<BrowserWorkspace["view"], { kind: "task" }>;
      const shown = view.status?.status.headline ?? view.status?.label;
      expect(shown, id).toBe(headline);
      expect(view.status!.status.tone === "danger", id).toBe(headline === "Failed");
      if (headline !== "Failed") expect(view.status!.status.details.every(one => one.mark !== "failed"), id).toBe(true);
    }
  });

  test("the Chat result and the build page", async () => {
    const result = await page(`/chat?task=fix-checkout-tax&result=${runs["fix-checkout-tax"]}`);
    expect(result).toContain('data-current-outcome data-headline="Complete"');
    expect(result).not.toContain("Publish failed");
    const failing = await page(`/chat?task=coupon-stacking&result=${runs["coupon-stacking"]}`);
    expect(failing).toContain('data-headline="Failed"');
    expect(failing).toContain('data-status-detail="checks" data-mark="failed"');
    const review = workspaceOf(await page(`/review?result=fix-checkout-tax&run=${runs["fix-checkout-tax"]}`)).view as Extract<BrowserWorkspace["view"], { kind: "result" }>;
    expect(review.selected!.status.label).toBe("Complete");
    expect(review.selected!.panel?.status?.headline ?? review.selected!.status.label).toBe("Complete");
  });

  test("the chat card (Telegram, Slack, Discord, Teams)", () => {
    const card = telegramProgressCard(store, store.getRun(runs["fix-checkout-tax"]!)!, "fix-checkout-tax", REPO, NOW, root);
    expect(card.text.split("\n").slice(1, 3)).toEqual(["✅ Complete", "Marked complete by sam."]);
    expect(card.text).toContain("✓ Project checks · Passed on");
    expect(card.text).toContain("⚠ Pull request · Couldn't open — Open it on GitHub");
    expect(card.text).not.toMatch(/Publication failed|✕/);
    const failing = telegramProgressCard(store, store.getRun(runs["coupon-stacking"]!)!, "coupon-stacking", REPO, NOW, root);
    expect(failing.text.split("\n")[1]).toBe("❌ Failed");
    expect(failing.text).toContain("✕ Project checks · Failed (exit 1)");
    const ready = telegramProgressCard(store, store.getRun(runs["search-typo-tolerance"]!)!, "search-typo-tolerance", REPO, NOW, root);
    expect(ready.text.split("\n")[1]).toBe("✅ Ready for review");
  });

  test("toolroll status", () => {
    const status = installationStatus(store, NOW);
    expect(Object.fromEntries(status.tasks.map(one => [one.task, one.headline]))).toEqual(EXPECTED);
  });

  test("a completed task and its revisions count 0 in Ready for review: status, the console and chat", async () => {
    const status = installationStatus(store, NOW);
    expect(status.waitingForReview.count).toBe(1);
    expect(status.waitingForReview.results.map(one => one.task)).toEqual(["search-typo-tolerance"]);
    // Any version of the family reads Complete, and only the current one is a task of its own.
    for (const id of ["review-once", "review-once-2", "review-once-3"]) expect(taskWaitSnapshot(store, id, NOW)?.outcome, id).toBe("Complete");
    expect(status.tasks.filter(one => one.task.startsWith("review-once")).map(one => one.headline)).toEqual(["Complete"]);
    // The console: Home's counts, Catch up, and the Tasks list.
    const home = workspaceOf(await page("/chat")).home!;
    expect(home.counts.find(one => one.key === "ready")!.value).toBe(1);
    expect(home.catchUp.filter(one => one.id.startsWith("review-once")).map(one => [one.tab, one.label])).toEqual([["finished", "Complete"]]);
    const tasks = workspaceOf(await page("/work")).view as Extract<BrowserWorkspace["view"], { kind: "tasks" }>;
    expect(tasks.rows.filter(row => row.status.label === "Ready for review").map(row => row.id)).toEqual(["search-typo-tolerance"]);
    // Chat: the status reply, the task picker and the result card.
    const reply = phoneStatus(store, [REPO], NOW);
    // Four finished families; the task and its two revisions are one of them.
    expect(reply).toContain("Finished · 4");
    expect(reply.match(/— Ready for review$/gm)).toHaveLength(1);
    expect(phoneTaskChoices(store, [REPO], NOW, "review").map(one => [one.id, one.label])).toEqual([["review-once", "Complete"]]);
    // The task view of the root and of each revision, superseded or current.
    for (const id of ["review-once", "review-once-2", "review-once-3"]) expect(phoneTask(store, [REPO], id, NOW).split("\n")[4], id).toBe("Complete");
    const card = telegramProgressCard(store, store.getRun(runs["review-once-3"]!)!, "review-once-3", REPO, NOW, root);
    expect(card.text.split("\n")[1]).toBe("✅ Complete");
  });

  test("every status count equals what assignment show says", async () => {
    const access = { principal: "operator" as const, repos: [REPO] };
    const work = workIndexPage(store, NOW, access, { limit: 100 });
    // assignment show's state, and its headline through task-status.ts.
    const shown = work.items.map(one => {
      const assignment = assignmentOf(store, one.rootId, NOW, access, root)!;
      const work = taskWorkSummaryOf(store, assignment.activeTaskId, NOW, access)!.status;
      return { id: one.rootId, state: assignment.state, headline: assignmentTaskStatusOf(assignment, { workStatus: work }).headline };
    });
    const headlines = (headline: string) => shown.filter(one => one.headline === headline).length;
    expect(headlines("Complete")).toBe(3);
    expect(headlines("Ready for review")).toBe(1);
    expect(Object.fromEntries(work.items.map(one => [one.rootId, [one.assignmentState, one.status.label]])))
      .toEqual(Object.fromEntries(shown.map(one => [one.id, [one.state, one.headline]])));
    const status = installationStatus(store, NOW);
    expect(status.waitingForReview.count).toBe(headlines("Ready for review"));
    expect(Object.fromEntries(status.tasks.map(one => [one.task, one.headline]))).toEqual(Object.fromEntries(shown.map(one => [one.id, one.headline])));
    expect(work.totals.completed).toBe(headlines("Complete"));
    expect(work.totals["needs-you"]).toBe(shown.filter(one => one.state === "needs-decision" || one.state === "ready-to-check").length);
    const home = workspaceOf(await page("/chat")).home!;
    expect(home.counts.find(one => one.key === "ready")!.value).toBe(headlines("Ready for review"));
    expect(home.counts.find(one => one.key === "waiting")!.value).toBe(headlines("Needs you") + headlines("Failed"));
  });
});
