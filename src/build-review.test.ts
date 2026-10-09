/**
 * One automatic review per finished build: queued only when the project's
 * switch is on and the approved check passed, run once by the project's
 * review phase agent, HIGH sends the work back once, everything else and
 * every failure reaches the person.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { htmlString } from "./html.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { addApprover, approve, propose } from "./scope.js";
import { storeEvidence } from "./evidence.js";
import { sealVerificationReceipt } from "./verification-evidence.js";
import { maybeRequestAutoReview } from "./dispose.js";
import { buildReviewOf, buildReviewPass, revisionNoteOf } from "./build-review.js";
import { parseBuildFindings, type BuildFinding } from "./reviewer.js";
import { assignmentOf } from "./assignment.js";
import { register } from "./runner.js";
import { runOperate } from "./operate.js";
import { presetTerms, modeTermsJson, modeDigestOf, modeWords } from "./modes.js";
import { createDecisionServer } from "./serve.js";
import { checkSettingsHtml } from "./check-levels-ui.js";
import { recordRunCheckLevel } from "./check-levels.js";
import { assignmentStatusFacts, taskStatusOf } from "./task-status.js";
import type { Runner } from "./builder.js";
import { fakePid } from "../test/fake-pid.js";

const REPO = "/repos/review";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const PATCH = ["diff --git a/src/payouts.ts b/src/payouts.ts", "--- a/src/payouts.ts", "+++ b/src/payouts.ts", "@@ -1,2 +1,3 @@", "+export const limit = 100;", ""].join("\n");
const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };

let dir: string, db: string, root: string, store: Store, token: string;
const now = () => new Date();

/** A reviewer that replies with these findings and records what it was given. */
function reviewer(findings: BuildFinding[] | (() => Partial<typeof OK>), calls: { args: string[] }[] = []): Runner {
  return async (_file, args, options) => {
    calls.push({ args: [...args] });
    // A fake provider pid that is not running, as the real transport records one.
    options?.onSpawn?.(fakePid(calls.length));
    if (typeof findings === "function") return { ...OK, ...findings() };
    return { ...OK, stdout: JSON.stringify({ structured_output: { version: 1, findings }, session_id: `review-${calls.length}` }) };
  };
}

/** A finished, committed build of `taskId` whose approved check exited `exit`. */
function finishedBuild(taskId: string, exit = 0): number {
  const ref = store.lookupRef(taskId)!;
  const authority = store.routeAuthorityFor(ref.id, "builder");
  if (!authority?.ok) throw new Error("fixture route");
  const at = now();
  const run = store.startRun({ taskRef: ref.id, leaseId: `lease-${taskId}`, runner: "builder-1", branch: `so/${taskId}`, worktree: `/pool/${taskId}`, route: authority.stamp, now: at });
  store.stampRun(run, { scopeDigest: store.getScope(taskId)!.digest, baseRevision: BASE });
  storeEvidence(store, root, run, "terminal-diff", "terminal-diff.patch", Buffer.from(PATCH), "git diff (exit 0)", at, { captureStatus: "ok" });
  storeEvidence(store, root, run, "check-log", "check.txt", Buffer.from(exit === 0 ? "1 passed" : "1 failed"), "npm test", at, { captureStatus: "ok" });
  store.recordOutcomeFacts(run, { headRevision: HEAD, handoff: "Added the payout limit." });
  store.finishRun(run, { outcome: "built", committed: true, now: at });
  store.setTaskState(taskId, "done", at);
  sealVerificationReceipt(store, root, run, HEAD, store.liveVerifyCommand(REPO)!, { configured: true, ran: true, exitCode: exit }, at);
  return run;
}

function fileTask(taskId: string): void {
  const at = now();
  store.createTask({ id: taskId, title: "Cap payouts" }, at);
  store.placeTask(store.lookupRef(taskId)!.id, REPO);
  propose(store, { taskId, goal: "Reject payouts above the limit", acceptance: [{ id: "c1", statement: "Oversized payouts are rejected", how: null, evidence: ["check"] }], now: at });
  expect(approve(store, taskId, "alex", at, store.getScope(taskId)!.digest, token).ok).toBe(true);
}

function fileCandidateTask(taskId: string): void {
  const at = now();
  store.createTask({ id: taskId, title: "Release gate" }, at);
  store.placeTask(store.lookupRef(taskId)!.id, REPO);
  propose(store, { taskId, goal: "Verify the release candidate", acceptance: [{ id: "c1", statement: "The candidate passes its check", how: null, evidence: ["check"] }], candidate: HEAD, now: at });
  expect(approve(store, taskId, "alex", at, store.getScope(taskId)!.digest, token).ok).toBe(true);
}

function signHandsOff(): void {
  const terms = presetTerms("hands-off", new Date(Date.now() + 86_400_000).toISOString());
  store.signMode({ repo: REPO, name: "hands-off", termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: "alex", absoluteExpiry: terms.absoluteExpiry, publication: terms.publication }, now());
}

const pass = (agent: Runner) => buildReviewPass(store, { runner: "builder-1", token: "tok-builder-1", repos: [REPO], root, clock: now, agent });
/** The policy log's review-switch entries, oldest first. */
const switchLog = () => store.handle.prepare("SELECT actor, repo, detail FROM action_ledger WHERE source = 'policy' AND action = 'automatic review' ORDER BY id").all()
  .map(row => ({ actor: String(row["actor"]), repo: String(row["repo"]), detail: String(row["detail"]) }));
const reviewers = (taskId: string) => store.runsFor(store.lookupRef(taskId)!.id).filter(run => run.role === "reviewer");
const assignment = (taskId: string) => assignmentOf(store, taskId, now(), { principal: "operator", repos: [REPO] }, root)!;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-build-review-"));
  db = join(dir, "orders.db");
  root = join(dir, "evidence");
  store = openStore(db);
  const alex = addApprover(store, "alex", now());
  if (!alex.ok) throw new Error("fixture approver");
  token = alex.token;
  for (const phase of ["plan", "build"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "alex", now());
  // The review phase agent differs from the builder, so the test sees which ran.
  store.setPhaseConfig("installation", "review", "claude", "opus", "alex", now());
  register(store, { name: "builder-1", host: "test", capacity: 4, repos: [REPO], now: now(), newToken: () => "tok-builder-1" });
  store.setVerifyCommand({ repo: REPO, command: "npm test", timeoutMs: 60_000, approvedBy: "alex" }, new Date(Date.now() - 60_000));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the review switch (c5)", () => {
  test("off by default, on by default under a hands-off mode, set from the CLI and recorded in the policy log", async () => {
    expect(store.reviewSwitch(REPO, now())).toMatchObject({ on: false, source: "default" });
    signHandsOff();
    expect(store.reviewSwitch(REPO, now())).toMatchObject({ on: true, source: "hands-off" });
    expect(modeWords(presetTerms("hands-off", new Date(Date.now() + 86_400_000).toISOString())).join("\n")).toMatch(/one read-only review.*HIGH finding sends it back once/);
    store.close();

    const cli = async (...args: string[]) => {
      const lines: string[] = [];
      const code = await runOperate("review", [...args, "--json"], line => lines.push(line), { databaseFile: db, now: now() });
      return { code, body: JSON.parse(lines.join("\n")) };
    };
    expect(await cli("off", "--repo", REPO, "--as", "alex", "--token", `${token}x`)).toMatchObject({ code: 3, body: { ok: false } });
    expect(await cli("off", "--repo", REPO)).toMatchObject({ code: 2, body: { ok: false } });
    expect(await cli("off", "--repo", REPO, "--as", "alex", "--token", token)).toMatchObject({ code: 0, body: { ok: true, on: false, source: "project" } });
    expect(await cli("show", "--repo", REPO)).toMatchObject({ body: { on: false, source: "project" } });
    expect(await cli("on", "--repo", REPO, "--as", "alex", "--token", token)).toMatchObject({ body: { on: true, source: "project" } });

    store = openStore(db);
    expect(switchLog()).toEqual([
      { actor: "alex", repo: REPO, detail: "on (hands-off default) → off" },
      { actor: "alex", repo: REPO, detail: "off → on" },
    ]);
  });

  test("Settings → Checks shows the switch and an approver turns it on with the password; the change is logged", async () => {
    const server: Server = createDecisionServer({ store, evidenceRoot: root, repo: REPO });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address !== "object") throw new Error("listen");
      const base = `http://127.0.0.1:${address.port}`;
      const login = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token }), redirect: "manual" });
      const cookie = login.headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
      const page = await (await fetch(`${base}/settings/checks?repo=${encodeURIComponent(REPO)}`, { headers: { cookie } })).text();
      expect(page).toContain('data-review-switch="off"');
      expect(page).toContain("Turn on");
      const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(page)![1]!;
      const post = (password: string) => fetch(`${base}/settings/checks`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, repo: REPO, act: "review", on: "1", password }), redirect: "manual" });
      expect((await post("wrong")).status).toBe(303);
      expect(store.reviewSwitch(REPO, now())).toMatchObject({ on: false, source: "default" });
      expect((await post(token)).status).toBe(303);
      expect(store.reviewSwitch(REPO, now())).toMatchObject({ on: true, source: "project", changedBy: "alex" });
      expect(switchLog()).toEqual([{ actor: "alex", repo: REPO, detail: "off (default) → on" }]);
      const after = await (await fetch(`${base}/settings/checks?repo=${encodeURIComponent(REPO)}&said=x`, { headers: { cookie } })).text();
      expect(after).toContain('data-review-switch="on"');
      expect(after).toContain("Turn off");
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  test("a person who cannot change it sees the state without a control", () => {
    const html = htmlString(checkSettingsHtml({ repo: REPO, name: "review", csrf: "", canChange: false, level: "full", full: null, quick: null, suggestion: null, said: null, problem: null, review: { on: true, source: "hands-off" } }));
    expect(html).toContain("On while hands-off lasts");
    expect(html).not.toContain('name="act" value="review"');
  });
});

describe("one review per finished build (c1)", () => {
  test("nothing is queued while the switch is off or when the check failed", () => {
    fileTask("off");
    const off = finishedBuild("off");
    maybeRequestAutoReview(store, REPO, off, true, false, now(), root);
    expect(buildReviewOf(store, off)).toBeNull();

    store.setReviewSwitch(REPO, true, "alex", now());
    fileTask("red");
    const red = finishedBuild("red", 1);
    maybeRequestAutoReview(store, REPO, red, true, false, now(), root);
    expect(buildReviewOf(store, red)).toBeNull();
    expect(store.openReviewRequests()).toEqual([]);
  });

  test("a passing release candidate check is never reviewed and reaches the person Ready", async () => {
    store.setReviewSwitch(REPO, true, "alex", now());
    fileCandidateTask("gate");
    expect(store.getScope("gate")!.candidate).toBe(HEAD);
    const run = finishedBuild("gate");
    maybeRequestAutoReview(store, REPO, run, true, false, now(), root);
    expect(buildReviewOf(store, run)).toBeNull();
    expect(store.handle.prepare("SELECT 1 FROM build_review WHERE run = ?").get(run)).toBeUndefined();
    expect(store.openReviewRequests()).toEqual([]);
    expect(await pass(reviewer([]))).toEqual([]);
    expect(reviewers("gate")).toHaveLength(0);
    expect(assignment("gate")).toMatchObject({ state: "ready-to-check", handoff: { kind: "result" } });
  });

  test("with the project's checks Off, a finished build is reviewed without a check", () => {
    store.setReviewSwitch(REPO, true, "alex", now());
    fileTask("off-checks");
    const run = finishedBuild("off-checks", 1);
    recordRunCheckLevel(store, { id: run, taskId: "off-checks", repo: REPO }, "off", "project", now());
    maybeRequestAutoReview(store, REPO, run, true, false, now(), root);
    expect(buildReviewOf(store, run)).toMatchObject({ state: "pending" });
  });

  test("a passing build gets exactly one read-only reviewer run from the review phase agent before it reaches the person", async () => {
    store.setReviewSwitch(REPO, true, "alex", now());
    fileTask("work");
    const run = finishedBuild("work");
    maybeRequestAutoReview(store, REPO, run, true, false, now(), root);
    maybeRequestAutoReview(store, REPO, run, true, false, now(), root);
    expect(buildReviewOf(store, run)).toMatchObject({ state: "pending" });
    expect(store.openReviewRequests()).toHaveLength(1);
    // Held back from the person while the review is pending.
    expect(assignment("work")).toMatchObject({ state: "checking", handoff: null, review: { state: "pending" } });
    // The task's status: still the Building headline, in words that say it is reviewing.
    expect(taskStatusOf(assignmentStatusFacts(assignment("work")))).toMatchObject({ headline: "Building", sentence: "Reviewing the change before it reaches you." });

    const calls: { args: string[] }[] = [];
    const reports = await pass(reviewer([], calls));
    expect(reports).toEqual([{ run, outcome: "reviewed", detail: "0 findings, 0 high" }]);
    expect(calls).toHaveLength(1);
    const argv = calls[0]!.args;
    expect(argv[argv.indexOf("--model") + 1]).toBe("opus");
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("plan");
    expect(argv).not.toContain("--resume");
    const brief = argv[argv.indexOf("-p") + 1]!;
    expect(brief).toContain("Reject payouts above the limit");
    expect(brief).toContain("c1: Oversized payouts are rejected");
    expect(brief).toContain("+export const limit = 100;");

    expect(reviewers("work")).toHaveLength(1);
    expect(reviewers("work")[0]).toMatchObject({ outcome: "no-change", parentRun: run, provider: "claude", model: "opus" });
    expect(assignment("work")).toMatchObject({ state: "ready-to-check", review: { state: "reviewed", high: [], followUps: [] } });

    // Nothing reviews it again: not a replayed disposition, not another pass.
    maybeRequestAutoReview(store, REPO, run, true, false, now(), root);
    expect(await pass(reviewer([], calls))).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(reviewers("work")).toHaveLength(1);
  });
});

describe("HIGH findings (c2)", () => {
  const high: BuildFinding = { severity: "HIGH", file: "src/payouts.ts", line: 1, scenario: "A payout of 101 is accepted because the limit is never checked." };

  test("a HIGH sends the task back once with the finding in its notes; a HIGH on that revision goes to the person", async () => {
    signHandsOff();
    fileTask("work");
    const first = finishedBuild("work");
    maybeRequestAutoReview(store, REPO, first, true, false, now(), root);
    const reports = await pass(reviewer([high, { severity: "LOW", file: "src/payouts.ts", line: 1, scenario: "The limit is a bare number without a name for its unit." }]));
    const revision = buildReviewOf(store, first)!.sentBackAs!;
    expect(revision).toBeTruthy();
    expect(reports).toEqual([{ run: first, outcome: "sent-back", detail: `2 findings, 1 high; sent back as ${revision}` }]);
    // The existing revise path: a revision of the same family, its note the HIGH finding.
    const notes = store.allDiffComments(first);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ consumedBy: revision, note: revisionNoteOf([high]) });
    expect(notes[0]!.note).toContain("src/payouts.ts:1 — A payout of 101 is accepted");
    expect(store.revisionSourceOf(store.lookupRef(revision)!.id)).toMatchObject({ sourceRun: first, sourceTask: "work" });
    // Filed under the hands-off mode: approved without waiting.
    expect(store.getScope(revision)).toMatchObject({ approvedBy: "alex" });
    expect(assignment("work")).toMatchObject({ activeTaskId: revision });

    const second = finishedBuild(revision);
    maybeRequestAutoReview(store, REPO, second, true, false, now(), root);
    const again = await pass(reviewer([high]));
    expect(again).toEqual([{ run: second, outcome: "reviewed", detail: "1 finding, 1 high" }]);
    expect(buildReviewOf(store, second)).toMatchObject({ state: "reviewed", sentBackAs: null, high: [high] });
    expect(store.revisionsFromRun(second)).toEqual([]);
    const current = assignment("work");
    expect(current).toMatchObject({ state: "ready-to-check", activeTaskId: revision, handoff: { kind: "result" } });
    expect(current.attention).toContain(`Review: HIGH src/payouts.ts:1 — ${high.scenario}`);
  });

  test("the revision note stays within the revise path's 500-character limit", () => {
    const many = Array.from({ length: 6 }, (_, index) => ({ ...high, line: index + 1, scenario: `${"x".repeat(150)} ${index}.` }));
    const note = revisionNoteOf(many);
    expect(note.length).toBeLessThanOrEqual(500);
    expect(note.endsWith("…")).toBe(true);
  });
});

describe("MEDIUM and LOW never block (c3)", () => {
  test("they reach the person as suggested follow-ups on task show, assignment show --json and the result page", async () => {
    store.setReviewSwitch(REPO, true, "alex", now());
    fileTask("work");
    const run = finishedBuild("work");
    maybeRequestAutoReview(store, REPO, run, true, false, now(), root);
    const medium: BuildFinding = { severity: "MEDIUM", file: "src/payouts.ts", line: 1, scenario: "A negative payout passes the limit check." };
    const low: BuildFinding = { severity: "LOW", file: "src/payouts.ts", line: 1, scenario: "The limit has no unit in its name." };
    expect(await pass(reviewer([medium, low]))).toEqual([{ run, outcome: "reviewed", detail: "2 findings, 0 high" }]);
    expect(store.revisionsFromRun(run)).toEqual([]);
    expect(assignment("work")).toMatchObject({ state: "ready-to-check", review: { followUps: [medium, low], high: [] } });
    store.close();

    const cli = async (command: string, args: string[], json = true) => {
      const lines: string[] = [];
      await runOperate(command, [...args, ...(json ? ["--json"] : [])], line => lines.push(line), { databaseFile: db, evidenceRoot: root, now: now() });
      return lines.join("\n");
    };
    expect(JSON.parse(await cli("task", ["show", "work"]))).toMatchObject({ automaticReview: { state: "reviewed", followUps: [medium, low] } });
    expect(await cli("task", ["show", "work"], false)).toContain(`suggested follow-up: MEDIUM src/payouts.ts:1 — ${medium.scenario}`);
    expect(JSON.parse(await cli("assignment", ["show", "work"]))).toMatchObject({ result: { state: "ready-to-check", review: { followUps: [medium, low] } } });
    expect(JSON.parse(await cli("task", ["review", String(run)]))).toMatchObject({ ok: true, review: { followUps: [medium, low] } });
    store = openStore(db);

    const server: Server = createDecisionServer({ store, evidenceRoot: root, repo: REPO });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address !== "object") throw new Error("listen");
      const base = `http://127.0.0.1:${address.port}`;
      const login = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token }), redirect: "manual" });
      const cookie = login.headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
      const html = await (await fetch(`${base}/r/${run}`, { headers: { cookie } })).text();
      expect(html).toContain('data-review-followups="2"');
      expect(html).toContain("Suggested follow-ups");
      expect(html).toContain("A negative payout passes the limit check.");
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

describe("a failed review never blocks (c4)", () => {
  const cases: [string, () => Partial<typeof OK>, RegExp][] = [
    ["the reviewer exits with an error", () => ({ code: 1, stdout: JSON.stringify({ result: "Rate limited.", is_error: true, session_id: "review-error" }) }), /exited with code 1/],
    ["the reviewer times out", () => ({ code: 143, timedOut: true }), /timed out/],
    ["the reviewer's reply is unusable", () => ({ stdout: JSON.stringify({ structured_output: { version: 1, findings: [{ severity: "CRITICAL", file: "x", line: 1, scenario: "y" }] } }) }), /unusable/],
  ];
  for (const [name, reply, words] of cases) {
    test(`${name}: the result reaches the person marked not reviewed`, async () => {
      store.setReviewSwitch(REPO, true, "alex", now());
      fileTask("work");
      const run = finishedBuild("work");
      maybeRequestAutoReview(store, REPO, run, true, false, now(), root);
      const reports = await pass(reviewer(reply));
      expect(reports).toMatchObject([{ run, outcome: "not-reviewed", detail: expect.stringMatching(words) }]);
      expect(reviewers("work")).toHaveLength(1);
      expect(reviewers("work")[0]!.outcome).not.toBeNull();
      expect(store.revisionsFromRun(run)).toEqual([]);
      const current = assignment("work");
      expect(current).toMatchObject({ state: "ready-to-check", handoff: { kind: "result" }, review: { state: "not-reviewed" } });
      expect(current.attention.some(one => one.startsWith("Not reviewed:"))).toBe(true);
      // Never retried.
      expect(await pass(reviewer([]))).toEqual([]);
      expect(reviewers("work")).toHaveLength(1);
    });
  }

  test("a review interrupted mid-run settles as not reviewed on the next pass", async () => {
    store.setReviewSwitch(REPO, true, "alex", now());
    fileTask("work");
    const run = finishedBuild("work");
    maybeRequestAutoReview(store, REPO, run, true, false, now(), root);
    const request = store.openReviewRequests()[0]!;
    const admitted = store.admitReview(request.id, { runner: "builder-1", token: "tok-builder-1", provider: "claude", model: "opus" }, now());
    if (!admitted.ok) throw new Error(admitted.reason);
    store.handle.prepare("UPDATE build_review SET reviewer_run = ? WHERE run = ?").run(admitted.reviewerRunId, run);
    store.finishRun(admitted.reviewerRunId, { outcome: "failed", reason: "interrupted", now: now() });
    expect(await pass(reviewer([]))).toEqual([]);
    expect(buildReviewOf(store, run)).toMatchObject({ state: "not-reviewed", reason: "the review was interrupted" });
    expect(assignment("work").state).toBe("ready-to-check");
  });
});

describe("the reply parser", () => {
  test("accepts graded findings and refuses anything else whole", () => {
    expect(parseBuildFindings('{"version":1,"findings":[]}')).toEqual({ ok: true, findings: [] });
    expect(parseBuildFindings('```json\n{"version":1,"findings":[{"severity":"LOW","file":"a.ts","line":3,"scenario":"one\\nline"}]}\n```'))
      .toEqual({ ok: true, findings: [{ severity: "LOW", file: "a.ts", line: 3, scenario: "one line" }] });
    for (const bad of ["not json", '{"version":2,"findings":[]}', '{"version":1}', '{"version":1,"findings":[{"severity":"HIGH","file":"a.ts","line":0,"scenario":"x"}]}',
      '{"version":1,"findings":[{"severity":"HIGH","file":"","line":1,"scenario":"x"}]}', '{"version":1,"findings":[{"severity":"HIGH","file":"a.ts","line":1,"scenario":""}]}']) {
      expect(parseBuildFindings(bad).ok).toBe(false);
    }
  });
});

describe("a deploy reads the candidate's code over the installed file", () => {
  test("no build_review table yet reads as no review, not an error", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const older = new DatabaseSync(":memory:");
    try { expect(buildReviewOf({ handle: older } as unknown as Store, 1)).toBeNull(); } finally { older.close(); }
  });
});
