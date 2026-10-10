/** Check levels: Quick while building, Full as before, Off when asked; a task
 * can override its project; the status words say honestly what ran; Run
 * checks and Add tests work on any result; Merge waits for the full check.
 * Real HTTP against an ephemeral port, the real CLI, and a real git
 * repository for checks on an exact commit. No GitHub, no model. */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { register } from "./runner.js";
import { addApprover, approve, propose } from "./scope.js";
import { storeEvidence } from "./evidence.js";
import { sealVerificationReceipt } from "./verification-evidence.js";
import { createDecisionServer } from "./serve.js";
import { assignmentOf, checkAssignmentAsOperator } from "./assignment.js";
import { assignmentTaskStatusOf } from "./assignment-presentation.js";
import { taskStatusOf, completionBlockersOf, requirementWordOf, HEADLINES, HEADLINE_TONE } from "./task-status.js";
import { releaseCoverageOf } from "./release-coverage.js";
import { workIndexPage, workIndexTask } from "./work-index.js";
import { verifyApproverByPassword } from "./principal.js";
import { completeAndOpenPullRequest, mergePullRequest, pullRequestViewOf, savePublishing } from "./pull-request-flow.js";
import { runOperate, EXIT } from "./operate.js";
import { applyChatTaskAction, chatTaskStamp } from "./chat-task-actions.js";
import { LEAD_TOOLS } from "./lead-tools.js";
import { confirmLeadProposal } from "./lead-doors.js";
import {
  checkCommandFor, checkLevelFromWords, effectiveCheckLevel, projectCheckLevel, quickVerifyKey, recordRunCheckLevel, setProjectCheckLevel,
  setTaskCheckLevel, suggestQuickCommand, taskCheckLevel, requiredCheckCommandFor, type CheckLevel,
} from "./check-levels.js";
import { followUpChecksOf, fullCheckGate, requestFollowUpChecks, runFollowUpCheck, withFollowUps } from "./result-follow-ups.js";
import type { BrowserWorkspace } from "./browser-workspace.js";
import { mixedCheckScreenshot } from "../test/status-evidence-fixture.js";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

let dir: string;
let REPO: string;
let HEAD: string;
let store: Store;
let server: Server;
let base: string;
let root: string;
let databaseFile: string;
let password: string;
let cookie: string;
const runs: Record<string, number> = {};

function workspaceOf(html: string): BrowserWorkspace {
  const json = /<script type="application\/json" id="standing-orders-workspace-data"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
  expect(json).toBeDefined();
  return JSON.parse(json!);
}
const page = async (path: string) => (await fetch(`${base}${path}`, { headers: { cookie } })).text();
const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
const post = async (path: string, fields: Record<string, string>) =>
  fetch(`${base}${path}`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields), redirect: "manual" });
const taskView = async (id: string) => workspaceOf(await page(`/t/${id}`)).view as Extract<BrowserWorkspace["view"], { kind: "task" }>;
const statusOf = (id: string) => assignmentTaskStatusOf(assignmentOf(store, id, NOW, { principal: "operator", repos: [REPO] }, root)!);

function filed(id: string, title: string, at: Date, checks?: CheckLevel): number {
  store.createTask({ id, title }, at);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, REPO, {}, at);
  if (checks !== undefined) expect(setTaskCheckLevel(store, id, checks, "sam", at)).toEqual({ ok: true });
  const proposed = propose(store, { taskId: id, goal: title, touches: ["src/"], acceptance: [{ id: "c1", statement: title, how: null, evidence: ["check"] }], now: at });
  const ok = approve(store, id, "sam", at, proposed.digest, password);
  if (!ok.ok) throw new Error(ok.reason);
  return ref;
}

/** A finished build as the builder leaves it at each level: the level it used, and the check it ran (none for Off). */
function built(id: string, title: string, at: Date, level: CheckLevel, exitCode = 0, checks?: CheckLevel, head = HEAD, release = false): number {
  const ref = filed(id, title, at, checks);
  const authority = store.routeAuthorityFor(ref, "builder");
  if (!authority?.ok) throw new Error("route");
  const run = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "builder-1", branch: `toolroll/${id}`, worktree: `/pool/${id}`, route: authority.stamp, now: at });
  store.stampRun(run, { scopeDigest: store.getScope(id)!.digest, baseRevision: "1".repeat(40) });
  store.recordOutcomeFacts(run, { headRevision: head, handoff: `${title}.` });
  // A release check runs under Strict quality; its recorded result is indexed as the release check.
  if (release) store.handle.prepare("UPDATE run SET quality_mode = 'strict' WHERE id = ?").run(run);
  store.finishRun(run, { outcome: "built", committed: true, now: at });
  store.setTaskState(id, "done", at);
  recordRunCheckLevel(store, { id: run, taskId: id, repo: REPO }, level, checks === undefined ? "project" : "task", at);
  // The requirement rests on the project check: met when it passed, failed when it failed, waiting for it when Off.
  const passed = level !== "off" && exitCode === 0;
  store.saveProofVerdict(run, passed ? "verified" : level === "off" ? "short" : "refuted", [], at, [{ id: "c1", statement: title, requiredEvidence: ["check"],
    state: passed ? "pass" : level === "off" ? "missing" : "failed", detail: [], answered: passed ? [{ kind: "check", ref: checkCommandFor(store, REPO, level).command!.command }] : [], review: null }] as never, passed ? "verified" : level === "off" ? "attested" : "refuted");
  storeEvidence(store, root, run, "terminal-diff", "diff.patch", Buffer.from(`diff --git a/src/${id}.ts b/src/${id}.ts\n--- a/src/${id}.ts\n+++ b/src/${id}.ts\n@@ -1 +1 @@\n-a\n+b\n`), "git diff (exit 0)", at, { captureStatus: "ok" });
  storeEvidence(store, root, run, "diff-stat", "diff-stat.json", Buffer.from(JSON.stringify({ schema: 1, head, base: "1".repeat(40), filesTruncated: false, fileCount: 1, files: [{ path: `src/${id}.ts` }] })), "git diff --numstat", at, { captureStatus: "ok" });
  if (level !== "off") {
    const command = checkCommandFor(store, REPO, level).command!;
    storeEvidence(store, root, run, "check-log", "checks.txt", Buffer.from(exitCode === 0 ? "41 passed\n" : "1 failed\n"), command.command, at, { captureStatus: "ok" });
    sealVerificationReceipt(store, root, run, head, command, { configured: true, ran: true, exitCode }, at);
    store.recordRunCheck(run, { status: exitCode === 0 ? "passed" : "failed", exitCode, suites: [] }, at);
  } else {
    store.recordRunCheck(run, { status: "not-run", exitCode: null, suites: [] }, at);
  }
  runs[id] = run;
  return run;
}

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "check-levels-")));
  REPO = join(dir, "storefront");
  execFileSync("mkdir", ["-p", REPO]);
  git(REPO, "init", "-q", "-b", "main");
  writeFileSync(join(REPO, "app.txt"), "v1\n");
  writeFileSync(join(REPO, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit", test: "vitest run" }, devDependencies: { vitest: "^4" } }));
  git(REPO, "add", ".");
  git(REPO, "commit", "-q", "-m", "first");
  HEAD = git(REPO, "rev-parse", "HEAD");
  databaseFile = join(dir, "orders.db");
  root = join(dir, "evidence");
  store = openStore(databaseFile);
  register(store, { name: "builder-1", host: "test", capacity: 4, repos: [REPO], now: NOW, newToken: () => "tok-builder-1" });
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", ago(600));
  const sam = addApprover(store, "sam", ago(600));
  if (!sam.ok) throw new Error("approver");
  password = sam.token;
  // The full check proves it ran in a checkout of the exact commit: app.txt exists there.
  store.setVerifyCommand({ repo: REPO, command: "test -f app.txt", timeoutMs: 60_000, approvedBy: "sam" }, ago(600));
  store.setVerifyCommand({ repo: quickVerifyKey(REPO), command: "test -f package.json", timeoutMs: 60_000, approvedBy: "sam" }, ago(600));
  savePublishing(store, { repo: REPO, githubRepo: "sam-shop/storefront", remote: "origin", base: "main", account: "sam" }, "sam", {}, ago(600));

  built("quick-pass", "Show delivery dates on the cart", ago(90), "quick");
  built("quick-fail", "Round prices to cents", ago(85), "quick", 1);
  built("full-pass", "Cache the product list", ago(80), "full");
  built("checks-off", "Tweak the footer copy", ago(70), "off", 0, "off");

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
  rmSync(dir, { recursive: true, force: true });
});

describe("c1: a project is Quick, Full or Off, and a task can override it", () => {
  test("projects from before levels keep Full; a new project starts on Quick; an approver's change is in the ledger", () => {
    expect(projectCheckLevel(store, REPO).level).toBe("full");
    const fresh = join(dir, "fresh-project");
    store.upsertProject(fresh, "fresh-project", NOW);
    expect(projectCheckLevel(store, fresh)).toMatchObject({ level: "quick", setBy: "system" });
    // Opening it again changes nothing.
    store.upsertProject(fresh, "fresh-project", NOW);
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM action_ledger WHERE repo = ? AND action = 'check level changed'").get(fresh)!["n"]).toBe(1);
    // A project that already had an approved check keeps Full when it is first opened.
    store.upsertProject(REPO, "storefront", NOW);
    expect(projectCheckLevel(store, REPO).level).toBe("full");
    expect(setProjectCheckLevel(store, fresh, "off", "sam", NOW)).toEqual({ changed: true, before: "quick" });
    const entry = store.handle.prepare("SELECT actor, detail, source FROM action_ledger WHERE repo = ? AND action = 'check level changed' ORDER BY id DESC LIMIT 1").get(fresh)!;
    expect(entry).toMatchObject({ actor: "sam", detail: "Quick → Off", source: "policy" });
  });

  test("a task's choice overrides the project, a revision inherits it, and it is fixed once the plan is approved", () => {
    expect(effectiveCheckLevel(store, REPO, "checks-off")).toEqual({ level: "off", from: "task" });
    expect(effectiveCheckLevel(store, REPO, "quick-pass")).toEqual({ level: "full", from: "project" });
    expect(setTaskCheckLevel(store, "quick-pass", "off", "sam", NOW)).toMatchObject({ ok: false });
    store.createTask({ id: "draft-task", title: "Draft" }, NOW);
    store.placeTask(store.refFor("built-in", "draft-task").id, REPO, {}, NOW);
    expect(setTaskCheckLevel(store, "draft-task", "full", "sam", NOW)).toEqual({ ok: true });
    expect(taskCheckLevel(store, "draft-task")).toBe("full");
  });

  test("Quick runs its own command, or the full one when it has none; Off runs nothing", () => {
    expect(checkCommandFor(store, REPO, "quick")).toMatchObject({ level: "quick", command: { command: "test -f package.json" } });
    expect(checkCommandFor(store, REPO, "full")).toMatchObject({ level: "full", command: { command: "test -f app.txt" } });
    expect(checkCommandFor(store, REPO, "off")).toEqual({ level: "off", command: null });
    expect(checkCommandFor(store, join(dir, "fresh-project"), "quick")).toEqual({ level: "full", command: null });
    expect(requiredCheckCommandFor(store, REPO, "quick-pass", "quick")?.command).toBe("test -f package.json");
    expect(requiredCheckCommandFor(store, REPO, "full-pass", "full")?.command).toBe("test -f app.txt");
    expect(requiredCheckCommandFor(store, REPO, "checks-off", "off")).toBeNull();
    expect(requiredCheckCommandFor(store, REPO, "checks-off", null)).toBeNull();
    expect(suggestQuickCommand(REPO)).toBe("npm run typecheck && npx vitest related --run $(git diff --name-only HEAD~1)");
  });

  test("in chat: \"skip the tests\" and \"run the full checks\" become the task's checks", () => {
    expect(checkLevelFromWords("Please skip the tests for this one")).toBe("off");
    expect(checkLevelFromWords("don't run the checks")).toBe("off");
    expect(checkLevelFromWords("run the full checks")).toBe("full");
    expect(checkLevelFromWords("just quick checks")).toBe("quick");
    expect(checkLevelFromWords("add a test for the parser")).toBeNull();
    const who = verifyApproverByPassword(store, "sam", password, [REPO]);
    if (!who.ok) throw new Error("who");
    // The lead drafts the card under a real turn; the person confirms it through the door.
    const session = store.mintLeadSession({ approver: "sam", approverGeneration: who.who.generation, credentialKey: "fixture", ceilingMicrousd: 10_000_000, ceilingDigest: who.who.ceilingDigest, termsDigest: "fixture" }, NOW);
    const thread = store.openLeadThread("sam", who.who.ceilingDigest, NOW).thread.id;
    const turn = store.openLeadTurn({ approver: "sam", session, thread, credentialKey: "fixture", reservedMicrousd: 0, dailyTurns: 100, weeklyCeilingMicrousd: 10_000_000, deadlineMs: 60_000 }, NOW);
    if (!turn.ok) throw new Error(turn.reason);
    const started = store.startLeadTurn(turn.id, NOW);
    if (!started.ok) throw new Error("start");
    const drafts: number[] = [];
    const tool = LEAD_TOOLS.find(one => one.name === "propose_task")!;
    const ctx = { store, who: who.who, now: NOW, step: 1, readDecisions: new Map(),
      draft: (kind: string, payload: Record<string, unknown>) => { const id = store.draftLeadProposal({ thread, turn: turn.id, kind: kind as never, payload, ceilingDigest: who.who.ceilingDigest }, NOW); drafts.push(id); return id; } };
    const args = { repo: "r1", title: "Rename the footer link", goal: "Rename the footer's Help link to Support.", acceptance: [{ id: "c1", statement: "The footer says Support", evidence: ["manual-review"] }] };
    expect(tool.handle(ctx as never, { ...args, checks: "whenever" })).toMatchObject({ ok: false });
    expect(tool.handle(ctx as never, { ...args, checks: "skip the tests" })).toMatchObject({ ok: true });
    expect(store.getLeadProposal(drafts.at(-1)!)!.payload["checks"]).toBe("off");
    store.finalizeLeadTurn(turn.id, started.generation, { state: "answered", settledMicrousd: 0, tokensIn: 0, tokensOut: 0, message: { text: "Here's the task.", activity: "" } }, NOW);
    // The card shows the checks before the yes; confirming files the task with them.
    const filed = confirmLeadProposal(store, who.who, drafts.at(-1)!, NOW, { via: "web", evidenceRoot: root });
    expect(filed).toMatchObject({ ok: true, kind: "task" });
    expect(taskCheckLevel(store, (filed as { taskId: string }).taskId)).toBe("off");
  });

  test("the CLI: verify level, verify set --quick, verify show and task add --checks", async () => {
    const cli = async (command: string, ...args: string[]) => {
      const lines: string[] = [];
      const code = await runOperate(command, [...args, "--json"], line => lines.push(line), { databaseFile, now: NOW });
      return { code, envelope: JSON.parse(lines.join("\n")) as Record<string, unknown> };
    };
    const other = join(dir, "kiosk");
    expect((await cli("verify", "level", "sometimes", "--repo", other, "--as", "sam", "--token", password)).code).toBe(EXIT.usage);
    expect((await cli("verify", "level", "off", "--repo", other, "--as", "sam", "--token", "wrong")).code).toBe(EXIT.refused);
    expect(await cli("verify", "level", "off", "--repo", other, "--as", "sam", "--token", password)).toMatchObject({ code: EXIT.ok, envelope: { ok: true, level: "off" } });
    expect(projectCheckLevel(store, other)).toMatchObject({ level: "off", setBy: "sam" });
    expect(await cli("verify", "set", "--repo", other, "--quick", "npm run typecheck", "--as", "sam", "--token", password, "--yes"))
      .toMatchObject({ code: EXIT.ok, envelope: { ok: true, level: "quick" } });
    expect(store.liveVerifyCommand(quickVerifyKey(other))?.command).toBe("npm run typecheck");
    expect(store.liveVerifyCommand(other)).toBeNull();
    expect(await cli("verify", "show", "--repo", other)).toMatchObject({ envelope: { level: "off", verify: null, quick: { command: "npm run typecheck" } } });
    expect(await cli("verify", "clear", "--repo", other, "--level", "quick", "--as", "sam", "--token", password)).toMatchObject({ envelope: { ok: true, cleared: true } });
    expect(store.liveVerifyCommand(quickVerifyKey(other))).toBeNull();

    expect((await cli("task", "add", "Bad level", "--repo", REPO, "--checks", "fast")).code).toBe(EXIT.usage);
    const added = await cli("task", "add", "Fix the header", "--id", "header-fix", "--repo", REPO, "--checks", "off");
    expect(added).toMatchObject({ code: EXIT.ok, envelope: { ok: true, checks: "off" } });
    expect(taskCheckLevel(store, "header-fix")).toBe("off");
  });
});

describe("c2: Off reads Ready for review and says no check ran; a Quick pass reads Ready with Quick checks passed", () => {
  test("the shared status function", () => {
    expect(HEADLINES).not.toContain("Built, not checked");
    const off = taskStatusOf({ stage: "finished", checks: { status: "not-run", exitCode: null, head: HEAD, level: "off" }, links: { runChecks: "/r/1?tab=checks#follow-ups" } });
    expect(off.headline).toBe("Ready for review");
    expect(off.sentence).toBe("Checked at release. Review the change, then mark it complete.");
    expect(off.details[0]).toMatchObject({ key: "checks", text: "Checked at release", mark: "none", action: { label: "Run checks" } });
    const quick = taskStatusOf({ stage: "finished", checks: { status: "passed", exitCode: 0, head: HEAD, level: "quick" } });
    expect(quick.headline).toBe("Ready for review");
    expect(quick.sentence).toBe(`Quick checks passed on ${HEAD.slice(0, 7)}. Review the change, then mark it complete.`);
    expect(quick.details[0]).toMatchObject({ text: `Quick checks passed on ${HEAD.slice(0, 7)}`, mark: "ok" });
    // A full pass keeps its words; a failed quick check is Failed, in red.
    expect(taskStatusOf({ stage: "finished", checks: { status: "passed", exitCode: 0, head: HEAD, level: "full" } }).details[0]!.text).toBe(`Passed on ${HEAD.slice(0, 7)}`);
    expect(taskStatusOf({ stage: "finished", checks: { status: "failed", exitCode: 1, head: HEAD, level: "quick" } })).toMatchObject({ headline: "Failed", details: [{ text: "Quick checks failed (exit 1)", mark: "failed" }] });
    // Complete stays Complete: a person decided.
    expect(taskStatusOf({ stage: "complete", checks: { status: "not-run", exitCode: null, head: HEAD, level: "off" } }).headline).toBe("Complete");
  });

  test("each result's own status", () => {
    expect(statusOf("checks-off")).toMatchObject({ headline: "Ready for review" });
    expect(statusOf("quick-pass").headline).toBe("Ready for review");
    expect(statusOf("quick-pass").details.find(one => one.key === "checks")!.text).toBe(`Quick checks passed on ${HEAD.slice(0, 7)}`);
    expect(statusOf("quick-fail").headline).toBe("Failed");
    expect(statusOf("full-pass").details.find(one => one.key === "checks")!.text).toBe(`Passed on ${HEAD.slice(0, 7)}`);
  });

  test("the Tasks list and the task page say the same, and Off says no check ran", async () => {
    const workspace = workspaceOf(await page("/work"));
    const rows = (workspace.view as Extract<BrowserWorkspace["view"], { kind: "tasks" }>).rows;
    const label = (id: string) => rows.find(row => row.id === id)!.status;
    expect(label("checks-off")).toMatchObject({ label: "Ready for review" });
    expect(label("quick-pass").label).toBe("Ready for review");
    expect(label("quick-fail").label).toBe("Failed");
    const off = await taskView("checks-off");
    expect(off.status!.status.headline).toBe("Ready for review");
    expect(off.status!.status.details.find(one => one.key === "checks")).toMatchObject({ text: "Checked at release", mark: "none", action: { label: "Run checks" } });
    expect(off.status!.status.details.find(one => one.key === "requirements")).toMatchObject({ text: "0 of 1 met · 1 at release" });
    const quick = await taskView("quick-pass");
    expect(quick.status!.status.sentence).toContain("Quick checks passed");
  });
});

describe("c3: Run checks and Add tests work on any result", () => {
  test("Run checks: full checks on an Off result's exact commit upgrade it to Ready", async () => {
    const run = runs["checks-off"]!;
    const resultPage = await page(`/r/${run}?tab=checks`);
    expect(resultPage).toContain('data-follow-ups');
    expect(resultPage).toContain(">Run full checks</button>");
    const asked = await post(`/r/${run}/checks`, { csrf: csrfOf(resultPage), level: "full", return: `/r/${run}?tab=checks` });
    expect(asked.status).toBe(303);
    expect(followUpChecksOf(store, run, NOW)).toMatchObject([{ level: "full", head: HEAD, state: "waiting", actor: "sam" }]);
    // Asking again while it waits is the same request.
    expect(requestFollowUpChecks(store, { runId: run, level: "full", actor: "sam" }, NOW)).toMatchObject({ ok: true, existing: true });
    expect(statusOf("checks-off").details.find(one => one.key === "checks")).toMatchObject({ text: "Full checks running", mark: "running" });
    // A worker runs it once, in a fresh checkout of the exact commit (the check needs app.txt from it).
    const done = await runFollowUpCheck(store, root, followUpChecksOf(store, run, NOW)[0]!.request, { now: () => NOW });
    expect(done).toMatchObject({ state: "passed", exitCode: 0 });
    expect(await runFollowUpCheck(store, root, done!.request, { now: () => NOW })).toMatchObject({ state: "passed" });
    expect(git(REPO, "worktree", "list").split("\n")).toHaveLength(1);
    expect(statusOf("checks-off")).toMatchObject({ headline: "Ready for review" });
    expect(statusOf("checks-off").details.find(one => one.key === "checks")!.text).toBe(`Passed on ${HEAD.slice(0, 7)}`);
    expect((await taskView("checks-off")).status!.status.headline).toBe("Ready for review");
    const rows = (workspaceOf(await page("/work")).view as Extract<BrowserWorkspace["view"], { kind: "tasks" }>).rows;
    expect(rows.find(row => row.id === "checks-off")!.status.label).toBe("Ready for review");
  });

  test("Run checks: a quick pass upgraded by full checks, and a failure stays visible", async () => {
    const run = runs["quick-pass"]!;
    const asked = requestFollowUpChecks(store, { runId: run, level: "quick", actor: "sam" }, NOW);
    if (!asked.ok) throw new Error(asked.message);
    // The commit, not today's checkout: a quick check that fails on this commit is shown as failed.
    store.setVerifyCommand({ repo: quickVerifyKey(REPO), command: "test -f missing.txt", timeoutMs: 60_000, approvedBy: "sam" }, NOW);
    expect(await runFollowUpCheck(store, root, asked.request, { now: () => NOW })).toMatchObject({ state: "not-run", note: "The approved check changed before it started." });
    const again = requestFollowUpChecks(store, { runId: run, level: "quick", actor: "sam" }, NOW);
    if (!again.ok) throw new Error(again.message);
    expect(await runFollowUpCheck(store, root, again.request, { now: () => NOW })).toMatchObject({ state: "failed", exitCode: 1 });
    expect(statusOf("quick-pass")).toMatchObject({ headline: "Failed" });
    expect(statusOf("quick-pass").details.find(one => one.key === "checks")!.text).toBe("Quick checks failed (exit 1)");
    const full = requestFollowUpChecks(store, { runId: run, level: "full", actor: "sam" }, NOW);
    if (!full.ok) throw new Error(full.message);
    expect(await runFollowUpCheck(store, root, full.request, { now: () => NOW })).toMatchObject({ state: "passed" });
    expect(statusOf("quick-pass")).toMatchObject({ headline: "Ready for review" });
    // A later quick pass never replaces a full one.
    expect(withFollowUps({ status: "passed", level: "full", exitCode: 0, head: HEAD }, [{ level: "quick", state: "passed", head: HEAD, exitCode: 0 }]).level).toBe("full");
    store.setVerifyCommand({ repo: quickVerifyKey(REPO), command: "test -f package.json", timeoutMs: 60_000, approvedBy: "sam" }, NOW);
  });

  test("Run checks from the CLI and from chat", async () => {
    const lines: string[] = [];
    const code = await runOperate("task", ["checks", "full-pass", "--level", "quick", "--json"], line => lines.push(line), { databaseFile, now: NOW });
    expect(code).toBe(EXIT.ok);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ ok: true, level: "quick", state: "passed", head: HEAD });
    const who = verifyApproverByPassword(store, "sam", password, [REPO]);
    if (!who.ok) throw new Error("who");
    const stamp = chatTaskStamp(store, who.who, "quick-fail")!;
    expect(applyChatTaskAction(store, who.who, { task: "quick-fail", operation: "run_full_checks", stamp }, NOW, true)).toMatchObject({ ok: true, said: "Full checks are queued on this result's commit." });
    expect(followUpChecksOf(store, runs["quick-fail"]!, NOW).at(-1)).toMatchObject({ level: "full", state: "waiting" });
  });

  test("Add tests files one small, unapproved task for that change, from the result page, chat and the CLI", async () => {
    const run = runs["full-pass"]!;
    const resultPage = await page(`/r/${run}?tab=checks`);
    expect(resultPage).toContain(">Add tests</button>");
    const response = await post(`/r/${run}/add-tests`, { csrf: csrfOf(resultPage), return: `/r/${run}?tab=checks` });
    expect(response.status).toBe(303);
    const id = decodeURIComponent(/\/t\/([^?#]+)/.exec(response.headers.get("location") ?? "")![1]!);
    expect(store.getTask(id)).toMatchObject({ title: "Add tests for Cache the product list", state: "queued" });
    expect(store.lookupRef(id)!.repo).toBe(REPO);
    const scope = store.getScope(id)!;
    expect(scope.goal).toContain(`commit ${HEAD.slice(0, 7)}`);
    expect(scope.goal).toContain("src/full-pass.ts");
    expect(scope.approvedAt).toBeNull();
    // Once per result: the page links the task, and asking again returns it.
    expect(await page(`/r/${run}?tab=checks`)).toContain(`Tests task: <a href="/t/${id}">`);
    const lines: string[] = [];
    await runOperate("task", ["add-tests", "full-pass", "--json"], line => lines.push(line), { databaseFile, now: NOW });
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ ok: true, filed: id, existing: true });
    const who = verifyApproverByPassword(store, "sam", password, [REPO]);
    if (!who.ok) throw new Error("who");
    const chat = applyChatTaskAction(store, who.who, { task: "quick-fail", operation: "add_tests", stamp: chatTaskStamp(store, who.who, "quick-fail") }, NOW, true, { evidenceRoot: root });
    expect(chat).toMatchObject({ ok: true });
    expect(store.getTask((chat as { taskId: string }).taskId)!.title).toBe("Add tests for Round prices to cents");
  });
});

describe("full checks before merge", () => {
  test("a Quick result's pull request runs the full check; Merge waits for it unless a person merges anyway", async () => {
    // Built after the quick command was last approved, so its own quick pass still reads.
    built("quick-pr", "Add a size guide link", NOW, "quick");
    const run = runs["quick-pr"]!;
    expect(fullCheckGate(store, run, NOW).state).toBe("not-requested");
    const who = verifyApproverByPassword(store, "sam", password, [REPO]);
    if (!who.ok) throw new Error("who");
    const assignment = assignmentOf(store, "quick-pr", NOW, { principal: "operator", repos: [REPO] }, root)!;
    const opened = completeAndOpenPullRequest(store, { taskId: "quick-pr", digest: assignment.receipt!.digest, runId: run, who: who.who, root }, NOW);
    if (!opened.ok) throw new Error(opened.message);
    expect(followUpChecksOf(store, run, NOW)).toMatchObject([{ level: "full", why: "pull-request", state: "waiting" }]);
    store.markPublicationPushed(opened.publication.id, NOW);
    store.markPublicationOpened(opened.publication.id, 7, "https://github.com/sam-shop/storefront/pull/7", NOW);
    store.recordPublicationCheckState(opened.publication.id, "passing", NOW);
    let merged = false;
    const exec = async (_file: string, args: readonly string[]) => {
      if (args[1] === "merge") { merged = true; return { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false }; }
      return { code: 0, stdout: JSON.stringify({ state: merged ? "MERGED" : "OPEN", isDraft: false, headRefOid: HEAD, statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }], mergeCommit: merged ? { oid: "9".repeat(40) } : null }), stderr: "", timedOut: false, notFound: false };
    };
    expect(pullRequestViewOf(store, run)!.fullCheck).toMatchObject({ state: "waiting" });
    expect(await mergePullRequest(store, { runId: run, by: "merge when checks pass", exec, clock: () => NOW })).toMatchObject({ ok: false, reason: "full-checks" });
    expect(merged).toBe(false);
    expect(await mergePullRequest(store, { runId: run, by: "sam", exec, clock: () => NOW, anyway: true })).toMatchObject({ ok: true });
    expect(merged).toBe(true);
    const entry = store.handle.prepare("SELECT detail FROM action_ledger WHERE run_id = ? AND action = 'pull request merged'").get(run)!;
    expect(String(entry["detail"])).toContain("merged without waiting for the full check");
  });

  test("once the full check passes on the commit, nothing waits", async () => {
    built("quick-pr-2", "Add a returns link", ago(20), "quick");
    const run = runs["quick-pr-2"]!;
    const asked = requestFollowUpChecks(store, { runId: run, level: "full", actor: "sam", why: "pull-request" }, NOW);
    if (!asked.ok) throw new Error(asked.message);
    expect(fullCheckGate(store, run, NOW).state).toBe("waiting");
    await runFollowUpCheck(store, root, asked.request, { now: () => NOW });
    expect(fullCheckGate(store, run, NOW)).toEqual({ state: "clear" });
    // A Full build never waits; a project with no full command leaves it to CI.
    expect(fullCheckGate(store, runs["full-pass"]!, NOW)).toEqual({ state: "clear" });
  });
});

describe("Settings → Projects → Checks", () => {
  test("an approver chooses the level and approves the quick command, with the password", async () => {
    const projects = await page("/projects");
    expect(projects).toContain(`/settings/checks?repo=${encodeURIComponent(REPO)}`);
    const settings = await page(`/settings/checks?repo=${encodeURIComponent(REPO)}`);
    expect(settings).toContain("<h1>Checks</h1>");
    expect(settings).toContain('name="level" value="full" checked');
    const csrf = csrfOf(settings);
    const wrong = await post("/settings/checks", { csrf, repo: REPO, act: "level", level: "quick", password: "nope" });
    expect(decodeURIComponent(wrong.headers.get("location") ?? "")).toContain("problem=Enter your Toolroll password");
    expect(projectCheckLevel(store, REPO).level).toBe("full");
    await post("/settings/checks", { csrf, repo: REPO, act: "level", level: "quick", password });
    expect(projectCheckLevel(store, REPO)).toMatchObject({ level: "quick", setBy: "sam" });
    await post("/settings/checks", { csrf, repo: REPO, act: "quick", command: "npm run typecheck", timeout: "120", password });
    expect(store.liveVerifyCommand(quickVerifyKey(REPO))).toMatchObject({ command: "npm run typecheck", timeoutMs: 120_000, approvedBy: "sam" });
    const after = await page(`/settings/checks?repo=${encodeURIComponent(REPO)}`);
    expect(after).toContain('name="level" value="quick" checked');
    expect(after).toContain("npm run typecheck");
    await post("/settings/checks", { csrf, repo: REPO, act: "level", level: "full", password });
  });
});

describe("upgrade: a result completed before check levels stays complete", () => {
  test("the receipt digest seals the proof, not the check's level or a follow-up still running", () => {
    const run = built("sealed-proof", "Keep a completed result complete", ago(40), "full");
    const read = () => assignmentOf(store, "sealed-proof", NOW, { principal: "operator", repos: [REPO] }, root)!;
    const before = read();
    expect(before.receipt!.checks.level).toBe("full");
    const who = verifyApproverByPassword(store, "sam", password, [REPO]);
    if (!who.ok) throw new Error("approver fixture");
    expect(checkAssignmentAsOperator(store, "sealed-proof", before.receipt!.digest, who.who, NOW, root).ok).toBe(true);
    expect(read().state).toBe("complete");
    // A follow-up check in flight shows as running, but never unseals the completion.
    expect(requestFollowUpChecks(store, { runId: run, level: "quick", actor: "sam" }, NOW)).toMatchObject({ ok: true });
    const after = read();
    expect(after.receipt!.checks.running).toBe("quick");
    expect(after.receipt!.digest).toBe(before.receipt!.digest);
    expect(after.state).toBe("complete");
  });
});

describe("checks Off are checked at release", () => {
  const commit = (file: string) => { writeFileSync(join(REPO, file), `${file}\n`); git(REPO, "add", file); git(REPO, "commit", "-q", "-m", file); return git(REPO, "rev-parse", "HEAD"); };
  const read = (id: string) => assignmentOf(store, id, NOW, { principal: "operator", repos: [REPO] }, root)!;

  test("Off reads Ready and Checked at release until a passing full release check contains its commit; nothing stored changes", async () => {
    const offHead = commit("off-change.txt");
    built("off-before-release", "Reword the delivery banner", ago(20), "off", 0, "off", offHead);
    const before = read("off-before-release");
    const proofBefore = store.proofVerdictFor(runs["off-before-release"]!);
    const status = () => assignmentTaskStatusOf(read("off-before-release"));
    expect(before.readiness).toEqual({ verdict: "short", checksOff: true, blockers: [] });
    expect(requirementWordOf(before.receipt!.proof!.matrix[0]!, null, "pending")).toBe("Checked at release");
    expect(status()).toMatchObject({ headline: "Ready for review", sentence: "Checked at release. Review the change, then mark it complete." });
    expect(status().details.find(one => one.key === "requirements")).toMatchObject({ text: "0 of 1 met · 1 at release" });

    // Not covered: a release check on an older commit, a failed one, and a quick one.
    built("release-older", "Release the previous build", ago(18), "full", 0, undefined, HEAD, true);
    const later = commit("release.txt");
    built("release-failed", "Release with a failing check", ago(17), "full", 1, undefined, later, true);
    built("release-quick", "Release with quick checks", ago(16), "quick", 0, undefined, later, true);
    expect(releaseCoverageOf(store, root, REPO, offHead)).toBeNull();
    expect(status().headline).toBe("Ready for review");

    // Covered: a passing full release check on a later commit that contains it.
    built("release-full", "Release the next version", ago(15), "full", 0, undefined, later, true);
    expect(releaseCoverageOf(store, root, REPO, offHead)).toEqual({ run: runs["release-full"], head: later });
    // Fails closed: a commit Git doesn't know, or no evidence root.
    expect(releaseCoverageOf(store, root, REPO, "e".repeat(40))).toBeNull();
    expect(releaseCoverageOf(store, undefined, REPO, offHead)).toBeNull();
    const after = read("off-before-release");
    expect(after.receipt!.checks.release).toEqual({ run: runs["release-full"], head: later });
    expect(status()).toMatchObject({ headline: "Ready for review", sentence: `Checked at release on ${later.slice(0, 7)}. Review the change, then mark it complete.` });
    expect(status().details.find(one => one.key === "checks")).toMatchObject({ text: `Passed at release on ${later.slice(0, 7)}`, mark: "ok" });
    expect(status().details.find(one => one.key === "requirements")).toMatchObject({ text: "1 of 1 met", mark: "ok" });
    // Derived at read time: the sealed receipt digest and the stored proof are unchanged.
    expect(after.receipt!.digest).toBe(before.receipt!.digest);
    expect(store.proofVerdictFor(runs["off-before-release"]!)).toEqual(proofBefore);
    // The Tasks list says the same.
    const rows = (workspaceOf(await page("/work")).view as Extract<BrowserWorkspace["view"], { kind: "tasks" }>).rows;
    expect(rows.find(row => row.id === "off-before-release")!.status).toMatchObject({ label: "Ready for review" });
    const listed = workIndexPage(store, NOW, { principal: "operator", repos: [REPO] }, { root }).items.find(one => one.rootId === "off-before-release")!;
    expect(listed.status).toMatchObject({ label: "Ready for review", detail: status().sentence });

    // task complete says nothing about checks that were deliberately Off.
    const lines: string[] = [];
    expect(await runOperate("task", ["complete", "off-before-release", "--as", "sam", "--token", password], line => lines.push(line), { databaseFile, now: NOW })).toBe(EXIT.ok);
    expect(lines.join("\n")).toMatch(/^off-before-release · Complete\nResult: off-before-release · run \d+ · [a-f0-9]{40}$/);
    expect(lines.join("\n")).not.toMatch(/check/i);
  });

  test("task complete refuses a failed or missing check, an unresolved requirement and a HIGH finding, and says what to do", async () => {
    const complete = async (id: string) => {
      const lines: string[] = [];
      const code = await runOperate("task", ["complete", id, "--as", "sam", "--token", password], line => lines.push(line), { databaseFile, now: NOW });
      return { code, said: lines.join("\n"), state: read(id).state };
    };
    built("refuse-failed", "Round totals", ago(14), "full", 1);
    expect(await complete("refuse-failed")).toEqual({ code: EXIT.refused, said: "Checks failed (exit 1). Fix them and run checks again, or ask for changes.", state: "ready-to-check" });

    built("refuse-missing", "Trim the footer", ago(13), "full");
    store.handle.prepare("DELETE FROM artifact WHERE run = ? AND kind IN ('check-log', 'verification-receipt')").run(runs["refuse-missing"]!);
    expect(read("refuse-missing").receipt!.checks.status).not.toBe("passed");
    expect(await complete("refuse-missing")).toMatchObject({ code: EXIT.refused, state: "ready-to-check" });
    expect((await complete("refuse-missing")).said).toContain("Run checks on it, then mark it complete.");

    built("refuse-criteria", "Show stock levels", ago(12), "full");
    const run = runs["refuse-criteria"]!;
    const proof = store.proofVerdictFor(run)!;
    store.handle.prepare("DELETE FROM proof_verdict WHERE run = ?").run(run);
    store.saveProofVerdict(run, "short", ["criterion \"c1\" is not met"], ago(12), [{ ...proof.matrix[0]!, state: "failed", detail: ["not met"] }], "short");
    expect(await complete("refuse-criteria")).toMatchObject({ code: EXIT.refused, said: "This requirement isn't met: Show stock levels. Ask for changes, or accept the result with a reason.", state: "ready-to-check" });

    built("refuse-high", "Cache prices", ago(11), "full");
    store.handle.prepare(`INSERT INTO build_review (run, task_id, repo, state, findings_json, queued_at, finished_at) VALUES (?, 'refuse-high', ?, 'reviewed', ?, ?, ?)`)
      .run(runs["refuse-high"]!, REPO, JSON.stringify({ version: 1, findings: [{ severity: "HIGH", file: "src/prices.ts", line: 4, scenario: "A stale price is charged after a change." }] }), ago(11).toISOString(), ago(11).toISOString());
    const high = read("refuse-high");
    expect(high.readiness).toMatchObject({ verdict: "refuted", blockers: [{ key: "high" }] });
    expect(assignmentTaskStatusOf(high)).toMatchObject({ headline: "Needs you", sentence: "The automatic review found a high-severity problem. Ask for changes before marking it complete." });
    expect(await complete("refuse-high")).toMatchObject({ code: EXIT.refused, said: "The automatic review found a high-severity problem. Ask for changes before marking it complete.", state: "ready-to-check" });
    // A pending review is never verified.
    store.handle.prepare("UPDATE build_review SET state = 'pending', findings_json = NULL WHERE run = ?").run(runs["refuse-high"]!);
    expect(read("refuse-high").readiness?.verdict).toBe("short");
  });

  test("an invalid screenshot plus a missing check cannot be completed after a passing check", async () => {
    const run = built("mixed-invalid-shot", "Keep checkout readable", ago(8), "full");
    const row = mixedCheckScreenshot({ path: "", ok: false, problem: "not a PNG or JPEG" });
    store.handle.prepare("DELETE FROM proof_verdict WHERE run = ?").run(run);
    store.saveProofVerdict(run, "short", row.detail, ago(8), [row], "short");
    const lines: string[] = [];
    expect(await runOperate("task", ["complete", "mixed-invalid-shot", "--as", "sam", "--token", password], line => lines.push(line), { databaseFile, now: NOW })).toBe(EXIT.refused);
    expect(lines.join("\n")).toContain("requirement");
    expect(read("mixed-invalid-shot").readiness?.blockers).toMatchObject([{ key: "criteria" }]);
  });

  test("Quick-only projects still require the Quick check when its log is missing", async () => {
    const run = built("quick-only-missing", "Check checkout totals", ago(7), "quick");
    const heldRepo = `${REPO}-full-command-held`;
    store.handle.prepare("UPDATE verify_command SET repo = ? WHERE repo = ?").run(heldRepo, REPO);
    try {
      store.handle.prepare("DELETE FROM artifact WHERE run = ? AND kind IN ('check-log', 'verification-receipt')").run(run);
      store.handle.prepare("DELETE FROM run_check WHERE run = ?").run(run);
      // No verdict can stand in for the required machine check.
      store.handle.prepare("DELETE FROM proof_verdict WHERE run = ?").run(run);
      expect(read("quick-only-missing").readiness?.blockers).toMatchObject([{ key: "check-missing" }]);
      const listed = workIndexPage(store, NOW, { principal: "operator", repos: [REPO] }, { limit: 100, root }).items.find(one => one.activeTaskId === "quick-only-missing")!;
      expect(listed.status.label).toBe("Needs you");
      const lines: string[] = [];
      expect(await runOperate("task", ["complete", "quick-only-missing", "--as", "sam", "--token", password], line => lines.push(line), { databaseFile, now: NOW })).toBe(EXIT.refused);
      expect(lines.join("\n")).toContain("Run checks on it");
    } finally {
      store.handle.prepare("UPDATE verify_command SET repo = ? WHERE repo = ?").run(REPO, heldRepo);
    }
  });

  test("CLI show preserves recorded Failed, Complete and manual-review asks when evidence files disappear", async () => {
    for (const [id, level, exit, expected] of [["lost-failed", "full", 1, "Failed"], ["lost-complete", "full", 0, "Complete"], ["lost-manual", "full", 0, "Needs you"]] as const) {
      const run = built(id, "Confirm checkout stays readable on a phone", ago(6), level, exit);
      if (id === "lost-complete") {
        const who = verifyApproverByPassword(store, "sam", password, [REPO]);
        if (!who.ok) throw Error("approver");
        expect(checkAssignmentAsOperator(store, id, read(id).receipt!.digest, who.who, NOW, root)).toMatchObject({ ok: true });
      }
      if (id === "lost-manual") {
        store.handle.prepare("DELETE FROM proof_verdict WHERE run = ?").run(run);
        store.saveProofVerdict(run, "short", ['criterion "c1" requires manual-review evidence — an operator must accept it before this can verify'], ago(6),
          [{ id: "c1", statement: "Confirm checkout stays readable on a phone", requiredEvidence: ["manual-review"], state: "manual-review", detail: [], answered: [], review: null }], "short");
      }
      for (const artifact of store.artifactsFor(run)) rmSync(join(root, artifact.key), { force: true });
      const lines: string[] = [];
      expect(await runOperate("task", ["show", id, "--json"], line => lines.push(line), { databaseFile, now: NOW })).toBe(EXIT.ok);
      const shown = JSON.parse(lines.join("\n"));
      const listed = workIndexPage(store, NOW, { principal: "operator", repos: [REPO] }, { limit: 100, root }).items.find(one => one.activeTaskId === id)!;
      expect(shown.status).toEqual({ headline: expected, sentence: listed.status.detail });
      expect(shown.assignment.result.checks.status).toBe("unavailable");
      expect(shown.work.status.label).toBe(expected);
      if (id === "lost-manual") expect(shown.status.sentence).toContain("Check this requirement yourself");
      const completion: string[] = [];
      expect(await runOperate("task", ["complete", id, "--as", "sam", "--token", password], line => completion.push(line), { databaseFile, now: NOW })).toBe(EXIT.refused);
      expect(completion.join("\n")).toContain("Run checks on it");
    }
  });

  test("exact saved-status lookup is independent of the page limit and retains project admission", () => {
    const access = { principal: "operator" as const, repos: [REPO] };
    const all = workIndexPage(store, NOW, access, { limit: 100, root }).items;
    const last = all.at(-1)!;
    expect(all.length).toBeGreaterThan(1);
    expect(workIndexTask(store, last.activeTaskId, NOW, access, root)).toEqual(last);
    expect(workIndexTask(store, last.activeTaskId, NOW, { ...access, repos: [] }, root)).toBeNull();
    expect(workIndexTask(store, "unknown-task", NOW, access, root)).toBeNull();
  });

  test("the completion guard is one pure rule", () => {
    const row = { id: "c1", statement: "Totals round to cents", state: "missing", requiredEvidence: ["check"], answered: [] };
    const off = { status: "not-run" as const, exitCode: null, level: "off" as const };
    expect(completionBlockersOf({ report: false, checks: off, checkRequired: true, matrix: [row], verdict: "short", accepted: false, high: 0 })).toEqual([]);
    expect(completionBlockersOf({ report: false, checks: { ...off, level: "full" }, checkRequired: true, matrix: [row], verdict: "short", accepted: false, high: 0 }).map(one => one.key)).toEqual(["check-missing", "criteria"]);
    expect(completionBlockersOf({ report: false, checks: { status: "passed", exitCode: 0, level: "full" }, checkRequired: true, matrix: [row], verdict: "short", accepted: false, high: 0 })).toEqual([]);
    // A person's own check is theirs to give by completing; an acceptance resolves the rest, never a HIGH.
    expect(completionBlockersOf({ report: false, checks: null, checkRequired: false, matrix: [{ ...row, state: "manual-review", requiredEvidence: ["manual-review"] }], verdict: "short", accepted: false, high: 0 })).toEqual([]);
    expect(completionBlockersOf({ report: false, checks: null, checkRequired: false, matrix: [{ ...row, state: "failed" }], verdict: "short", accepted: true, high: 1 }).map(one => one.key)).toEqual(["high"]);
  });
});
