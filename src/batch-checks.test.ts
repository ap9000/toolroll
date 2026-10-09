/** Batch checks: results waiting together are checked once on a temporary batch commit; a failing batch is
 * split until the result that breaks it is found; conflicts fall back to one by one; nothing is merged into a
 * real branch; off by default, per project. A real git repository and the real approved-command runner; an
 * injected clock for the window. No model, no network. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { htmlString } from "./html.js";
import { withFormToken } from "./server/request-context.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { register } from "./runner.js";
import { addApprover, approve, propose } from "./scope.js";
import { recordRunCheckLevel } from "./check-levels.js";
import { batchesFullCheck, BATCH_WINDOW_MS, projectBatchChecks, setProjectBatchChecks } from "./batch-policy.js";
import { queueBatchCheck, runBatchChecks } from "./batch-checks.js";
import { followUpChecksOf, fullCheckGate } from "./result-follow-ups.js";
import { assignmentOf } from "./assignment.js";
import { assignmentTaskStatusOf } from "./assignment-presentation.js";
import { taskStatusOf } from "./task-status.js";
import { checkSettingsHtml } from "./check-levels-ui.js";
import { createDecisionServer } from "./serve.js";
import { runOperate, EXIT } from "./operate.js";
import { run as execRun } from "./exec.js";
import type { Runner } from "./backend.js";

const T0 = new Date("2026-10-01T12:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env }).trim();

let dir: string;
let REPO: string;
let OTHER: string;
let BASE: string;
let store: Store;
let root: string;
let databaseFile: string;
let password: string;
let n = 0;
/** Every approved check the runner started, with the commit it ran on. */
const checks: { cwd: string; commit: string }[] = [];
const runner: Runner = async (file, args, options) => {
  if (args.some(one => one.includes("broken.txt"))) checks.push({ cwd: String(options?.cwd), commit: git(String(options?.cwd), "rev-parse", "HEAD") });
  return execRun(file, args, options);
};

/** A branch off the base with one change, as a finished build leaves it. */
function commitOn(name: string, file: string, body: string): string {
  git(REPO, "checkout", "-q", "-b", `toolroll/${name}`, BASE);
  writeFileSync(join(REPO, file), body);
  git(REPO, "add", file);
  git(REPO, "commit", "-q", "-m", name);
  const head = git(REPO, "rev-parse", "HEAD");
  git(REPO, "checkout", "-q", "main");
  return head;
}

/** A finished Full build of a project with batching on, queued for its batch check at `when`. */
function finished(name: string, file: string, body: string, when: Date, options: { queue?: boolean } = {}): { run: number; head: string; task: string } {
  const task = `${name}-${++n}`;
  const head = commitOn(task, file, body);
  store.createTask({ id: task, title: `Change ${file}` }, when);
  const ref = store.refFor("built-in", task).id;
  store.placeTask(ref, REPO, {}, when);
  const proposed = propose(store, { taskId: task, goal: task, touches: ["."], acceptance: [{ id: "c1", statement: task, how: null, evidence: ["check"] }], now: when });
  const ok = approve(store, task, "sam", when, proposed.digest, password);
  if (!ok.ok) throw new Error(ok.reason);
  const authority = store.routeAuthorityFor(ref, "builder");
  if (!authority?.ok) throw new Error("route");
  const run = store.startRun({ taskRef: ref, leaseId: `l-${task}`, runner: "builder-1", branch: `toolroll/${task}`, worktree: `/pool/${task}`, route: authority.stamp, now: when });
  store.stampRun(run, { scopeDigest: store.getScope(task)!.digest, baseRevision: BASE });
  recordRunCheckLevel(store, { id: run, taskId: task, repo: REPO }, "full", "project", when);
  if (options.queue !== false) queueBatchCheck(store, { runId: run, taskId: task, repo: REPO, head, base: BASE, command: store.liveVerifyCommand(REPO)! }, when);
  store.recordOutcomeFacts(run, { headRevision: head, handoff: `${task}.` });
  store.finishRun(run, { outcome: "built", committed: true, now: when });
  store.setTaskState(task, "done", when);
  store.saveProofVerdict(run, "attested", [], when, [{ id: "c1", statement: task, requiredEvidence: ["check"], state: "manual-review", detail: [], answered: [], review: null }] as never, "attested");
  store.recordRunCheck(run, { status: "not-run", exitCode: null, suites: [] }, when);
  return { run, head, task };
}

const refsOf = () => git(REPO, "for-each-ref", "--format=%(refname) %(objectname)");
const worktreesOf = () => git(REPO, "worktree", "list", "--porcelain");
const latest = (run: number, now: Date) => followUpChecksOf(store, run, now, root).at(-1)!;
const statusOf = (task: string, now: Date) => assignmentTaskStatusOf(assignmentOf(store, task, now, { principal: "operator", repos: [REPO] }, root)!);
const pass = (now: Date) => runBatchChecks(store, root, { runner, now: () => now, scratch: dir });

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "batch-checks-")));
  REPO = join(dir, "storefront");
  OTHER = join(dir, "warehouse");
  execFileSync("mkdir", ["-p", REPO, OTHER]);
  git(REPO, "init", "-q", "-b", "main");
  writeFileSync(join(REPO, "app.txt"), "v1\n");
  git(REPO, "add", ".");
  git(REPO, "commit", "-q", "-m", "first");
  BASE = git(REPO, "rev-parse", "HEAD");
  databaseFile = join(dir, "orders.db");
  root = join(dir, "evidence");
  store = openStore(databaseFile);
  register(store, { name: "builder-1", host: "test", capacity: 4, repos: [REPO, OTHER], now: T0, newToken: () => "tok-builder-1" });
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", at(-600));
  const sam = addApprover(store, "sam", at(-600));
  if (!sam.ok) throw new Error("approver");
  password = sam.token;
  // The check fails exactly when a result added broken.txt, and needs app.txt from the commit it checks.
  store.setVerifyCommand({ repo: REPO, command: "test -f app.txt && test ! -f broken.txt", timeoutMs: 60_000, approvedBy: "sam" }, at(-600));
  store.upsertProject(REPO, "storefront", at(-600));
  store.upsertProject(OTHER, "warehouse", at(-600));
});

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => { checks.length = 0; });

describe("c3: off by default, set per project", () => {
  test("an unset project is off; an approver's change is audited and touches only that project", () => {
    expect(projectBatchChecks(store, REPO)).toEqual({ on: false, windowMs: BATCH_WINDOW_MS, setBy: null, at: null });
    expect(batchesFullCheck(store, REPO, "full", store.liveVerifyCommand(REPO))).toBe(false);
    expect(setProjectBatchChecks(store, REPO, true, "sam", T0)).toEqual({ changed: true, before: false });
    expect(setProjectBatchChecks(store, REPO, true, "sam", T0)).toEqual({ changed: false, before: true });
    expect(projectBatchChecks(store, REPO)).toMatchObject({ on: true, setBy: "sam", windowMs: 10 * 60_000 });
    expect(projectBatchChecks(store, OTHER).on).toBe(false);
    expect(store.handle.prepare("SELECT actor, outcome, detail, source FROM action_ledger WHERE repo = ? AND action = 'batch checks changed'").all(REPO))
      .toEqual([{ actor: "sam", outcome: "on", detail: "Batch checks off → on", source: "policy" }]);
    // Only the Full check of the project's own approved command is batched.
    expect(batchesFullCheck(store, REPO, "full", store.liveVerifyCommand(REPO))).toBe(true);
    expect(batchesFullCheck(store, REPO, "quick", store.liveVerifyCommand(REPO))).toBe(false);
    expect(batchesFullCheck(store, OTHER, "full", store.liveVerifyCommand(REPO))).toBe(false);
  });

  test("`project checks --batch on|off` needs an approver; without one nothing changes", async () => {
    const lines: string[] = [];
    const say = (line: string) => lines.push(line);
    expect(await runOperate("project", ["checks", "--repo", OTHER, "--json"], say, { databaseFile, now: T0 })).toBe(EXIT.ok);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ ok: true, repo: OTHER, batch: false, windowMinutes: 10 });
    lines.length = 0;
    expect(await runOperate("project", ["checks", "--batch", "on", "--repo", OTHER, "--as", "sam", "--token", "wrong", "--json"], say, { databaseFile, now: T0 })).toBe(EXIT.refused);
    expect(projectBatchChecks(store, OTHER).on).toBe(false);
    lines.length = 0;
    expect(await runOperate("project", ["checks", "--batch", "maybe", "--repo", OTHER], say, { databaseFile, now: T0 })).toBe(EXIT.usage);
    lines.length = 0;
    expect(await runOperate("project", ["checks", "--batch", "on", "--repo", OTHER, "--as", "sam", "--token", password, "--json"], say, { databaseFile, now: T0 })).toBe(EXIT.ok);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ ok: true, batch: true, before: false, changed: true });
    expect(projectBatchChecks(store, OTHER)).toMatchObject({ on: true, setBy: "sam" });
    lines.length = 0;
    expect(await runOperate("project", ["checks", "--batch", "off", "--repo", OTHER, "--as", "sam", "--token", password], say, { databaseFile, now: T0 })).toBe(EXIT.ok);
    expect(lines.join("\n")).toContain("batch checks are off");
    expect(projectBatchChecks(store, OTHER).on).toBe(false);
  });

  test("Settings → Projects → Checks: one state, and the terms restated before turning it on with the password", async () => {
    const view = { repo: REPO, name: "storefront", csrf: "c", canChange: true, level: "full" as const, full: store.liveVerifyCommand(REPO), quick: null, suggestion: null, said: null, problem: null };
    const off = htmlString(withFormToken("c", () => checkSettingsHtml({ ...view, batch: { on: false } })));
    expect(off).toContain('data-batch-checks="off"');
    expect(off).toContain("<h2>Batch checks</h2><p><strong>Off</strong>");
    expect(off).toContain("Nothing is merged into a real branch. Each result still lands on its own.");
    expect(off).toContain('name="act" value="batch"');
    // Someone who can't change it sees the state and no form.
    expect(htmlString(checkSettingsHtml({ ...view, canChange: false, batch: { on: true } }))).not.toContain('value="batch"');

    const server: Server = createDecisionServer({ store, evidenceRoot: root, repo: REPO, clock: () => T0 });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    try {
      const address = server.address();
      if (address === null || typeof address !== "object") throw new Error("listen");
      const base = `http://127.0.0.1:${address.port}`;
      const login = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "sam", token: password }), redirect: "manual" });
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
      const page = await (await fetch(`${base}/settings/checks?repo=${encodeURIComponent(REPO)}`, { headers: { cookie } })).text();
      expect(page).toContain('data-batch-checks="on"');
      const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;
      const post = (fields: Record<string, string>) => fetch(`${base}/settings/checks`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf, repo: REPO, act: "batch", ...fields }), redirect: "manual" });
      const wrong = await post({ on: "0", password: "nope" });
      expect(decodeURIComponent(wrong.headers.get("location") ?? "")).toContain("problem=Enter your Toolroll password");
      expect(projectBatchChecks(store, REPO).on).toBe(true);
      const off = await post({ on: "0", password });
      expect(decodeURIComponent(off.headers.get("location") ?? "")).toContain("said=Batch checks are off.");
      expect((await (await fetch(`${base}/settings/checks?repo=${encodeURIComponent(REPO)}`, { headers: { cookie } })).text())).toContain('data-batch-checks="off"');
      await post({ on: "1", password });
      expect(projectBatchChecks(store, REPO)).toMatchObject({ on: true, setBy: "sam" });
      expect(projectBatchChecks(store, OTHER).on).toBe(false);
    } finally {
      await new Promise<void>(done => server.close(() => done()));
    }
  });
});

describe("c1: results waiting together are checked once on a temporary batch commit", () => {
  test("a lone result waits for the window, then is checked on its own", async () => {
    const lone = finished("lone", "lone.txt", "lone\n", T0);
    expect(await pass(at(9))).toBe(0);
    expect(latest(lone.run, at(9))).toMatchObject({ why: "batch", state: "waiting", base: BASE });
    expect(statusOf(lone.task, at(9)).details.find(one => one.key === "checks")).toMatchObject({ text: "Waiting to check with other results", mark: "running" });
    expect(statusOf(lone.task, at(9)).sentence).toBe("Its full check runs with other results within 10 minutes. Review the change, then mark it complete.");
    expect(fullCheckGate(store, lone.run, at(9)).state).toBe("waiting");
    expect(await pass(at(10))).toBe(1);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.commit).toBe(lone.head);
    expect(latest(lone.run, at(10))).toMatchObject({ state: "passed", tested: lone.head, batch: { mode: "alone", members: [{ task: lone.task, head: lone.head }] } });
    expect(statusOf(lone.task, at(10)).details.find(one => one.key === "checks")!.text).toBe(`Passed on ${lone.head.slice(0, 7)}`);
    expect(fullCheckGate(store, lone.run, at(10))).toEqual({ state: "clear" });
  });

  test("two results in the window: one check on one detached batch commit, both marked checked together", async () => {
    const a = finished("cart", "cart.txt", "cart\n", at(20));
    const b = finished("prices", "prices.txt", "prices\n", at(21));
    const refs = refsOf(), worktrees = worktreesOf(), branch = git(REPO, "symbolic-ref", "HEAD");
    expect(await pass(at(21))).toBe(2);
    expect(checks).toHaveLength(1);
    const tested = checks[0]!.commit;
    expect([a.head, b.head, BASE]).not.toContain(tested);
    // The batch commit merged both onto the recorded base.
    expect(git(REPO, "rev-list", "--parents", "-n", "1", tested).split(" ")).toHaveLength(3);
    expect(git(REPO, "merge-base", "--is-ancestor", a.head, tested)).toBe("");
    expect(git(REPO, "merge-base", "--is-ancestor", b.head, tested)).toBe("");
    for (const [one, peer] of [[a, b], [b, a]] as const) {
      expect(latest(one.run, at(21))).toMatchObject({ state: "passed", head: one.head, tested,
        batch: { mode: "together", tested, base: BASE, members: [{ task: a.task, run: a.run, head: a.head }, { task: b.task, run: b.run, head: b.head }] } });
      const status = statusOf(one.task, at(21));
      expect(status.headline).toBe("Ready for review");
      expect(status.sentence).toBe("Checks passed together with 1 other result. Review the change, then mark it complete.");
      expect(status.details.find(row => row.key === "checks")).toMatchObject({ text: `Checked together with ${peer.task} on ${tested.slice(0, 7)}`, mark: "ok" });
      expect(fullCheckGate(store, one.run, at(21))).toEqual({ state: "clear" });
    }
    // Nothing was merged into a real branch: refs, the checked-out branch and worktrees are as they were.
    expect(refsOf()).toBe(refs);
    expect(git(REPO, "symbolic-ref", "HEAD")).toBe(branch);
    expect(worktreesOf()).toBe(worktrees);
    expect(git(REPO, "branch", "--all", "--contains", tested)).toBe("");
  });

  test("a sealed receipt that was changed afterwards no longer says passed", async () => {
    const a = finished("tamper-a", "ta.txt", "a\n", at(30));
    const b = finished("tamper-b", "tb.txt", "b\n", at(30));
    await pass(at(30));
    const receipt = store.artifactsFor(a.run).find(one => one.key.includes("batch-check-") && one.key.endsWith(".json"))!;
    const path = join(root, receipt.key);
    writeFileSync(path, readFileSync(path, "utf8").replace(a.head, b.head));
    expect(latest(a.run, at(30))).toMatchObject({ state: "not-run", note: "The saved check result could not be verified." });
    expect(latest(b.run, at(30))).toMatchObject({ state: "passed" });
  });

  test("long peer lists stay on one line; the full list is on the result", () => {
    const facts = { stage: "finished" as const, checks: { status: "passed" as const, exitCode: 0, head: "a".repeat(40), level: "full" as const,
      batch: { state: "together" as const, tested: "b".repeat(40), peers: ["show-delivery-dates-on-the-cart", "round-prices-to-cents", "cache-the-product-list", "footer"] } } };
    expect(taskStatusOf(facts).details[0]!.text).toBe("Checked together with show-delivery-dates-on-the-cart, round-prices-to-cents and 2 more on bbbbbbb");
  });
});

describe("c2: a failing batch is split; conflicts fall back to one by one; nothing reaches a real branch", () => {
  test("a failing batch of four is split until the result that breaks it is found; the others pass", async () => {
    const ok1 = finished("ok-one", "one.txt", "1\n", at(40));
    const ok2 = finished("ok-two", "two.txt", "2\n", at(40));
    const ok3 = finished("ok-three", "three.txt", "3\n", at(40));
    const bad = finished("breaks", "broken.txt", "oops\n", at(40));
    const refs = refsOf(), worktrees = worktreesOf();
    expect(await pass(at(41))).toBe(4);
    // All four, then [one, two] (passes), then [three, breaks] (fails), then each of those on its own.
    expect(checks.map(one => one.commit).filter(one => one === ok3.head || one === bad.head)).toEqual([ok3.head, bad.head]);
    expect(checks).toHaveLength(5);
    const pair = latest(ok1.run, at(41));
    expect(pair).toMatchObject({ state: "passed", batch: { mode: "together", members: [{ task: ok1.task }, { task: ok2.task }] } });
    expect(latest(ok2.run, at(41))).toMatchObject({ state: "passed", tested: pair.tested });
    expect(latest(ok3.run, at(41))).toMatchObject({ state: "passed", tested: ok3.head, batch: { mode: "split", members: [{ task: ok3.task }] } });
    expect(latest(bad.run, at(41))).toMatchObject({ state: "failed", exitCode: 1, tested: bad.head, batch: { mode: "split" } });
    expect(statusOf(bad.task, at(41))).toMatchObject({ headline: "Failed", sentence: `Checks failed on ${bad.head.slice(0, 7)}. See what broke, then retry or ask for changes.` });
    const row = statusOf(bad.task, at(41)).details.find(one => one.key === "checks")!;
    expect(row).toMatchObject({ text: "Failed on its own (exit 1)", why: "Its batch check failed, so it was checked on its own." });
    expect(statusOf(ok3.task, at(41)).details.find(one => one.key === "checks")!.text).toBe(`Passed on its own on ${ok3.head.slice(0, 7)}`);
    expect(fullCheckGate(store, bad.run, at(41)).state).toBe("failed");
    // Every attempt the breaking result was part of is in its own log.
    const log = store.artifactsFor(bad.run).find(one => one.key.includes("batch-check-") && one.key.endsWith(".log"))!;
    const text = readFileSync(join(root, log.key), "utf8");
    expect(text).toContain("Batch of 4:");
    expect(text).toContain("Batch of 2:");
    expect(text).toContain(`${bad.task} on its own`);
    expect(refsOf()).toBe(refs);
    expect(worktreesOf()).toBe(worktrees);
  });

  test("results that conflict when merged are checked one by one", async () => {
    const left = finished("left", "app.txt", "left\n", at(50));
    const right = finished("right", "app.txt", "right\n", at(50));
    const refs = refsOf(), worktrees = worktreesOf();
    expect(await pass(at(50))).toBe(2);
    expect(checks.map(one => one.commit)).toEqual([left.head, right.head]);
    expect(latest(left.run, at(50))).toMatchObject({ state: "passed", tested: left.head, batch: { mode: "conflict" } });
    expect(latest(right.run, at(50))).toMatchObject({ state: "passed", tested: right.head, batch: { mode: "conflict" } });
    expect(statusOf(right.task, at(50)).details.find(one => one.key === "checks")).toMatchObject({ text: `Passed on its own on ${right.head.slice(0, 7)}`,
      why: "It conflicted with another result when merged for a batch check, so it was checked on its own." });
    expect(refsOf()).toBe(refs);
    expect(worktreesOf()).toBe(worktrees);
    expect(git(REPO, "status", "--porcelain")).toBe("");
  });

  test("a result that changed, or a command that changed while waiting, is never checked on stale terms", async () => {
    const stale = finished("stale", "stale.txt", "s\n", at(60));
    const moved = finished("moved", "moved.txt", "m\n", at(60));
    store.recordOutcomeFacts(moved.run, { headRevision: BASE, handoff: "moved." });
    const command = store.liveVerifyCommand(REPO)!;
    store.setVerifyCommand({ repo: REPO, command: `${command.command} && true`, timeoutMs: 60_000, approvedBy: "sam" }, at(60));
    expect(await pass(at(60))).toBe(2);
    expect(checks).toHaveLength(0);
    expect(latest(stale.run, at(60))).toMatchObject({ state: "not-run", note: "The approved check changed while it waited. Run checks to check it now." });
    expect(latest(moved.run, at(60))).toMatchObject({ state: "not-run", note: "The result stopped or changed before its batch check." });
    store.setVerifyCommand({ repo: REPO, command: command.command, timeoutMs: 60_000, approvedBy: "sam" }, at(60));
  });

  test("turned off while results wait: each is checked on its own right away", async () => {
    const a = finished("off-a", "offa.txt", "a\n", at(70));
    const b = finished("off-b", "offb.txt", "b\n", at(70));
    setProjectBatchChecks(store, REPO, false, "sam", at(70));
    expect(await pass(at(70))).toBe(2);
    expect(checks.map(one => one.commit)).toEqual([a.head, b.head]);
    expect(latest(a.run, at(70))).toMatchObject({ state: "passed", batch: { mode: "alone" } });
    setProjectBatchChecks(store, REPO, true, "sam", at(70));
  });

  test("an abandoned batch claim reads as not finished, and is never claimed twice", async () => {
    const a = finished("abandoned", "ab.txt", "a\n", at(80), { queue: true });
    const request = latest(a.run, at(80)).request;
    store.recordAction({ at: at(80).toISOString(), actor: "system", repo: REPO, taskId: a.task, runId: a.run, action: "checks started", outcome: String(request), source: "work", detail: "limit 1000 · batch" });
    expect(await pass(at(95))).toBe(0);
    expect(checks).toHaveLength(0);
    expect(latest(a.run, at(95))).toMatchObject({ state: "not-run", note: "The check didn't finish." });
  });
});
