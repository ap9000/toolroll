/**
 * One set of agent states (docs/plans/agents-cockpit.md §1): the display state from four separate facts, one attempt's
 * own record read without guessing, and a project's complete counts for one person over the Tasks list's own families
 * — a result to accept stays until accepted, a failed check is a failure, a flow decision waits on a person, nothing is
 * capped, unplaced work is its own row, and an empty project is idle.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { displayStateOf, factsOfAttempt, NO_COUNTS, projectStates, rollUp, type StateFacts } from "./agent-state.js";
import type { AgentFacts } from "./agents-board.js";
import { markAgentSeen, recordAgentTurn } from "./agent-board.js";
import { addApprover, approve, propose } from "./scope.js";
import { register } from "./runner.js";
import { storeEvidence } from "./evidence.js";
import { sealVerificationReceipt } from "./verification-evidence.js";
import { flowFromSteps } from "./flows.js";
import { openStore, type Store } from "./store.js";

describe("the display state", () => {
  const facts = (over: Partial<StateFacts>): StateFacts => ({ activity: "finished", outcome: "built", obligation: false, unread: false, ...over });
  test.each([
    [{ obligation: true, activity: "running" }, "needs-you"],
    [{ obligation: true, outcome: "failed" }, "needs-you"],
    [{ outcome: "failed" }, "failed"],
    [{ outcome: "checks-failed" }, "failed"],
    [{ outcome: "failed", newerRunning: true }, "idle"],
    [{ activity: "stuck", outcome: "none" }, "stuck"],
    [{ activity: "paused", outcome: "none" }, "paused"],
    [{ activity: "running", outcome: "none" }, "working"],
    [{ activity: "pausing", outcome: "none" }, "working"],
    [{ activity: "stopping", outcome: "none" }, "working"],
    [{ activity: "queued", outcome: "none" }, "waiting"],
    [{ activity: "waiting", outcome: "none" }, "waiting"],
    [{ outcome: "built", unread: true }, "done"],
    [{ outcome: "no-change", unread: true }, "done"],
    [{ outcome: "built", unread: false }, "idle"],
    [{ activity: "stopped", outcome: "none" }, "idle"],
  ] as const)("%o is %s", (over, state) => {
    expect(displayStateOf(facts(over as Partial<StateFacts>))).toBe(state);
  });

  test("looking clears only a good finish", () => {
    for (const unread of [true, false]) {
      expect(displayStateOf(facts({ outcome: "failed", unread }))).toBe("failed");
      expect(displayStateOf(facts({ outcome: "checks-failed", unread }))).toBe("failed");
      expect(displayStateOf(facts({ obligation: true, unread }))).toBe("needs-you");
    }
    expect(displayStateOf(facts({ outcome: "built", unread: true }))).toBe("done");
    expect(displayStateOf(facts({ outcome: "built", unread: false }))).toBe("idle");
  });

  test("the roll-up takes the strongest state present, and nothing counted is idle", () => {
    expect(rollUp({ ...NO_COUNTS })).toEqual({ state: "idle", counts: NO_COUNTS });
    expect(rollUp({ ...NO_COUNTS, working: 3, done: 1 }).state).toBe("working");
    expect(rollUp({ ...NO_COUNTS, working: 3, failed: 1 }).state).toBe("failed");
    expect(rollUp({ ...NO_COUNTS, failed: 2, "needs-you": 1 }).state).toBe("needs-you");
    expect(rollUp({ ...NO_COUNTS, stuck: 1, paused: 1, working: 1 }).state).toBe("stuck");
  });
});

describe("one attempt's own record", () => {
  const T = new Date("2026-10-19T12:00:00.000Z");
  const attempt = (over: Partial<AgentFacts>): AgentFacts => ({
    runId: 1, taskRef: 1, taskId: "t", title: "t", repo: "/r", provider: "claude", runner: "b", outcome: null, reason: null,
    startedAt: T.toISOString(), finishedAt: null, legacy: false, taskState: "running", turn: "busy", stateAt: T.toISOString(), transcriptAt: T.toISOString(),
    stuckAt: null, said: null, saidNote: null, saidAt: null, diffFiles: null, toolKind: null, toolAt: null, phase: null, questionNote: null,
    repairing: false, question: null, seen: false, ...over });
  const later = new Date(T.getTime() + 60 * 60_000);
  const state = (over: Partial<AgentFacts>, now = later) => displayStateOf(factsOfAttempt(attempt(over), null, false, now));

  test("a stopped or refused attempt is not a failure; a failure on a settled task no longer leads", () => {
    expect(state({ outcome: "interrupted", taskState: "queued" })).toBe("idle");
    expect(state({ outcome: "refused", taskState: "queued" })).toBe("idle");
    expect(state({ outcome: "failed", taskState: "failed" })).toBe("failed");
    expect(state({ outcome: "failed", taskState: "cancelled" })).toBe("idle");
    expect(state({ outcome: "failed", taskState: "done" })).toBe("idle");
  });

  test("a parked attempt is a decision only while its task is open", () => {
    expect(state({ outcome: "parked", taskState: "queued" })).toBe("needs-you");
    expect(state({ outcome: "parked", taskState: "cancelled" })).toBe("idle");
  });

  test("a quiet build being repaired is at work, not stuck; a quiet one alone is stuck; a crashed or asking one needs a person", () => {
    expect(state({ repairing: true })).toBe("working");
    expect(state({})).toBe("stuck");
    expect(state({}, new Date(T.getTime() + 30_000))).toBe("working");
    expect(state({ turn: "crashed" })).toBe("needs-you");
    expect(state({ question: { id: 1, key: "q", text: "?" } })).toBe("needs-you");
  });

  test("an interruption in either spelling is stopped, and a parked attempt asks only while its decision is open", () => {
    expect(state({ outcome: "failed", reason: "interrupted", finishedAt: T.toISOString() })).toBe("idle");
    expect(state({ outcome: "interrupted", finishedAt: T.toISOString() })).toBe("idle");
    expect(state({ outcome: "failed", reason: "exit 1", finishedAt: T.toISOString() })).toBe("failed");
    const parked = attempt({ outcome: "parked", finishedAt: T.toISOString(), taskState: "queued" });
    expect(displayStateOf(factsOfAttempt(parked, null, false, later))).toBe("needs-you");
    expect(displayStateOf(factsOfAttempt(parked, null, false, later, true))).toBe("needs-you");
    expect(displayStateOf(factsOfAttempt(parked, null, false, later, false))).toBe("idle");
  });
});

describe("a project's counts, over the Tasks list's own families", () => {
  const NOW = new Date();
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
  let dir: string, REPO: string, OTHER: string, HEAD: string, root: string, password: string, store: Store;
  const access = (repos: string[] | null, unplaced: boolean) => ({ principal: "operator" as const, repos, ...(unplaced ? { includeUnplaced: true } : {}) });
  const of = (account = "sam", repos: string[] | null = [REPO, OTHER], unplaced = false) =>
    Object.fromEntries(projectStates(store, access(repos, unplaced), account, NOW, root).map(one => [one.repo ?? "(unplaced)", one]));

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "so-states-")));
    REPO = join(dir, "shop"); OTHER = join(dir, "ops");
    for (const repo of [REPO, OTHER]) { mkdirSync(repo); git(repo, "init", "-q", "-b", "main"); writeFileSync(join(repo, "a.txt"), "1\n"); git(repo, "add", "."); git(repo, "commit", "-q", "-m", "1"); }
    HEAD = git(REPO, "rev-parse", "HEAD");
    root = join(dir, "evidence");
    store = openStore(join(dir, "orders.db"));
    register(store, { name: "builder-1", host: "test", capacity: 4, repos: [REPO, OTHER], now: NOW, newToken: () => "tok" });
    for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", NOW);
    const sam = addApprover(store, "sam", NOW);
    if (!sam.ok) throw new Error("approver");
    password = sam.token;
    for (const repo of [REPO, OTHER]) store.setVerifyCommand({ repo, command: "npm test", timeoutMs: 60_000, approvedBy: "sam" }, new Date(NOW.getTime() - 60_000));
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  /** A finished build, approved and stopped, its evidence saved; its project check as given. */
  function built(id: string, check: "not-run" | "failed" = "not-run", repo = REPO): number {
    store.createTask({ id, title: id }, NOW);
    const ref = store.refFor("built-in", id).id;
    store.placeTask(ref, repo, {}, NOW);
    const proposed = propose(store, { taskId: id, goal: id, touches: ["src/"], acceptance: [{ id: "c1", statement: id, how: null, evidence: ["changed-path"] }], now: NOW });
    if (!approve(store, id, "sam", NOW, proposed.digest, password).ok) throw new Error("approve");
    const authority = store.routeAuthorityFor(ref, "builder");
    if (!authority?.ok) throw new Error("route");
    const wt = join(dir, `wt-${id}`); mkdirSync(wt);
    const run = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "builder-1", branch: `toolroll/${id}`, worktree: wt, route: authority.stamp, now: NOW });
    store.stampRun(run, { scopeDigest: store.getScope(id)!.digest, baseRevision: "1".repeat(40) });
    store.recordOutcomeFacts(run, { headRevision: HEAD, handoff: `${id}.` });
    store.raw().prepare("UPDATE run SET provider_started_at = ? WHERE id = ?").run(NOW.toISOString(), run);
    store.finishRun(run, { outcome: "built", committed: true, now: NOW });
    store.setTaskState(id, "done", NOW);
    store.saveProofVerdict(run, "attested", [], NOW, [{ id: "c1", statement: id, requiredEvidence: ["changed-path"], state: "pass", detail: [], answered: [{ kind: "changed-path", ref: "src/app.ts" }], review: null }] as never, "attested");
    storeEvidence(store, root, run, "terminal-diff", "diff.patch", Buffer.from(`diff --git a/x b/x\n`), "git diff (exit 0)", NOW, { captureStatus: "ok" });
    if (check === "failed") {
      // The project's approved check ran on this result and failed: its log, and the sealed receipt the result reads.
      storeEvidence(store, root, run, "check-log", "check.txt", Buffer.from("1 failed"), "npm test", NOW, { captureStatus: "ok" });
      sealVerificationReceipt(store, root, run, HEAD, store.liveVerifyCommand(repo)!, { configured: true, ran: true, exitCode: 1 }, NOW);
    } else store.recordRunCheck(run, { status: "not-run", exitCode: null, suites: [] }, NOW);
    store.raw().prepare("INSERT INTO run_process (run, pid, host, process_group, observed_at, exited_at) VALUES (?, NULL, ?, 0, ?, ?)").run(run, hostname(), NOW.toISOString(), NOW.toISOString());
    return run;
  }

  test("a result to accept stays needs-you after it is looked at; a failed check is a failure", () => {
    const ready = built("ready");
    built("checks-broke", "failed");
    expect(of()[REPO]!.counts).toMatchObject({ "needs-you": 1, failed: 1, done: 0 });
    markAgentSeen(store, "sam", ready, NOW);
    expect(of()[REPO]!.counts).toMatchObject({ "needs-you": 1, failed: 1 });
  });

  test("a flow card waiting at a person's decision counts; an empty visible project is idle; unplaced work is its own row", () => {
    const flow = store.createFlow({ repo: REPO, name: "Triage", by: "sam", definitionJson: JSON.stringify(flowFromSteps([{ title: "Decide", kind: "approval" }], null)) }, NOW);
    const start = (JSON.parse(store.getFlow(flow)!.definitionJson) as { start: string }).start;
    store.addFlowCard({ flow, title: "Refund?", description: null, stage: start, by: "sam", byKind: "person" }, NOW);
    const states = of();
    expect(states[REPO]!.counts["needs-you"]).toBe(1);
    expect(states[OTHER]).toEqual({ repo: OTHER, state: "idle", counts: NO_COUNTS, families: [], flowAsks: [] });
    // A task with no project yet: counted where the Tasks list counts it (for an operator who includes unplaced work).
    store.createTask({ id: "nowhere", title: "Somewhere" }, NOW);
    store.refFor("built-in", "nowhere");
    expect(of("sam", [REPO, OTHER], true)["(unplaced)"]?.counts["needs-you"]).toBe(1);
    expect(of("sam", [REPO, OTHER], false)["(unplaced)"]).toBeUndefined();
  });

  /** An open build, approved and started, not finished. */
  function live(id: string, repo = REPO): { ref: number; run: number } {
    store.createTask({ id, title: id }, NOW);
    const ref = store.refFor("built-in", id).id;
    store.placeTask(ref, repo, {}, NOW);
    const proposed = propose(store, { taskId: id, goal: id, touches: ["src/"], acceptance: [{ id: "c1", statement: id, how: null, evidence: ["changed-path"] }], now: NOW });
    if (!approve(store, id, "sam", NOW, proposed.digest, password).ok) throw new Error("approve");
    const authority = store.routeAuthorityFor(ref, "builder");
    if (!authority?.ok) throw new Error("route");
    const wt = join(dir, `wt-${id}`); mkdirSync(wt);
    const run = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "builder-1", branch: `toolroll/${id}`, worktree: wt, route: authority.stamp, now: NOW });
    store.setTaskState(id, "running", NOW);
    return { ref, run };
  }

  test("a stop not yet settled is still at work, never an ask", () => {
    const { ref, run } = live("halting");
    store.raw().prepare("INSERT INTO run_stop (run, task_ref, requested_by, requested_via, requested_at) VALUES (?, ?, 'sam', 'web', ?)").run(run, ref, NOW.toISOString());
    expect(of()[REPO]!.counts).toMatchObject({ "needs-you": 0, working: 1 });
  });

  test("a recorded failed check is a failure even without its receipt; a good result with no failure is an ask", () => {
    const run = built("recorded-broke");
    store.raw().prepare("UPDATE run_check SET status = 'failed', exit_code = 1 WHERE run = ?").run(run);
    built("fine");
    expect(of()[REPO]!.counts).toMatchObject({ failed: 1, "needs-you": 1 });
  });

  test("a crashed build needs a person; each live attempt counts once", () => {
    const crashed = live("crashed");
    const key = String(store.raw().prepare("SELECT attempt_key FROM run WHERE id = ?").get(crashed.run)!["attempt_key"]);
    recordAgentTurn(store, { run: crashed.run, attemptKey: key, state: "crashed", at: NOW });
    live("busy-1"); live("busy-2", OTHER);
    const states = of();
    expect(states[REPO]!.counts).toMatchObject({ "needs-you": 1, working: 1 });
    expect(states[REPO]!.state).toBe("needs-you");
    expect(states[OTHER]!.counts.working).toBe(1);
  });

  test("a stop whose run has ended but is not yet settled is still at work", () => {
    const run = built("halted");
    const ref = store.refFor("built-in", "halted").id;
    store.raw().prepare("INSERT INTO run_stop (run, task_ref, requested_by, requested_via, requested_at) VALUES (?, ?, 'sam', 'web', ?)").run(run, ref, NOW.toISOString());
    expect(of()[REPO]!.counts).toMatchObject({ working: 1, "needs-you": 0 });
    expect(of()[REPO]!.state).toBe("working");
  });

  test("a family the person's lead is on waits on nobody, but a failure still leads", () => {
    built("claimed-ready");
    store.createTask({ id: "claimed-broke", title: "claimed broke" }, NOW);
    store.placeTask(store.refFor("built-in", "claimed-broke").id, REPO, {}, NOW);
    store.setTaskState("claimed-broke", "failed", NOW);
    for (const taskId of ["claimed-ready", "claimed-broke"])
      store.recordAction({ at: NOW.toISOString(), actor: "lead for sam", repo: REPO, taskId, runId: null, action: "lead is on it", outcome: "ok", source: "work" });
    const viewer = Object.fromEntries(projectStates(store, { principal: "operator", repos: [REPO], viewer: "sam" }, "sam", NOW, root).map(one => [one.repo, one]));
    expect(viewer[REPO]!.counts).toMatchObject({ failed: 1, waiting: 1, "needs-you": 0 });
    // Another person's lead is not this person's: for them the result still asks.
    expect(of()[REPO]!.counts).toMatchObject({ failed: 1, "needs-you": 1 });
  });

  test("two live attempts of one family, in two roles, count twice", () => {
    const { ref } = live("shared");
    const authority = store.routeAuthorityFor(ref, "planner");
    if (!authority?.ok) throw new Error("route");
    const wt = join(dir, "wt-shared-plan"); mkdirSync(wt);
    store.startRun({ taskRef: ref, leaseId: "l-shared-plan", runner: "builder-1", branch: "toolroll/shared-plan", worktree: wt, route: authority.stamp, role: "planner", now: NOW });
    const roles = store.raw().prepare("SELECT role FROM run WHERE task_ref = ? AND outcome IS NULL ORDER BY id").all(ref).map(row => row["role"]);
    expect(roles).toEqual(["builder", "planner"]);
    expect(of()[REPO]!.counts).toMatchObject({ working: 2, "needs-you": 0 });
  });

  test("a passing follow-up check clears an earlier failure: the result asks again", () => {
    const run = built("rechecked", "failed");
    store.recordRunCheck(run, { status: "failed", exitCode: 1, suites: [] }, NOW); // the recorded failure, too
    expect(of()[REPO]!.counts).toMatchObject({ failed: 1, "needs-you": 0 });
    const request = store.recordAction({ at: NOW.toISOString(), actor: "operator:sam", repo: REPO, taskId: "rechecked", runId: run, action: "checks requested", outcome: "full", source: "work", detail: `${HEAD} · person` });
    store.recordAction({ at: NOW.toISOString(), actor: "operator:sam", repo: REPO, taskId: "rechecked", runId: run, action: "checks started", outcome: String(request), source: "work" });
    storeEvidence(store, root, run, "structured-output", "follow-up.json", Buffer.from(JSON.stringify({ request, head: HEAD, result: { ran: true, exitCode: 0 } })), "follow-up check receipt v1", NOW, { captureStatus: "ok" });
    store.recordAction({ at: NOW.toISOString(), actor: "operator:sam", repo: REPO, taskId: "rechecked", runId: run, action: "checks finished", outcome: `${request}:passed`, source: "work", detail: "exit 0" });
    expect(of()[REPO]!.counts).toMatchObject({ failed: 0, "needs-you": 1 });
  });

  test("a flow card's ask is the visit's: an edit to the card never makes it new", () => {
    const flow = store.createFlow({ repo: OTHER, name: "Review", by: "sam", definitionJson: JSON.stringify(flowFromSteps([{ title: "Decide", kind: "approval" }], null)) }, NOW);
    const start = (JSON.parse(store.getFlow(flow)!.definitionJson) as { start: string }).start;
    const card = store.addFlowCard({ flow, title: "Refund?", description: null, stage: start, by: "sam", byKind: "person" }, NOW);
    const ask = () => of()[OTHER]!.flowAsks[0]!;
    const before = ask();
    store.raw().prepare("UPDATE flow_card SET updated_at = ?, note = 'a comment' WHERE id = ?").run(new Date(NOW.getTime() + 3_600_000).toISOString(), card);
    expect(ask()).toEqual(before);
  });

  test("flow decisions are counted without a cap", () => {
    const flow = store.createFlow({ repo: OTHER, name: "Bulk", by: "sam", definitionJson: JSON.stringify(flowFromSteps([{ title: "Decide", kind: "approval" }], null)) }, NOW);
    const start = (JSON.parse(store.getFlow(flow)!.definitionJson) as { start: string }).start;
    for (let i = 0; i < 501; i++) store.addFlowCard({ flow, title: `card ${i}`, description: null, stage: start, by: "sam", byKind: "person" }, NOW);
    expect(of()[OTHER]!.counts["needs-you"]).toBe(501);
  });

  test("nothing is capped: every family counts, and only the projects a person may see", () => {
    for (let i = 0; i < 85; i++) {
      store.createTask({ id: `broke-${i}`, title: `broke ${i}` }, NOW);
      store.placeTask(store.refFor("built-in", `broke-${i}`).id, OTHER, {}, NOW);
      store.setTaskState(`broke-${i}`, "failed", NOW);
    }
    expect(of()[OTHER]!.counts.failed).toBe(85);
    expect(Object.keys(of("sam", [REPO]))).toEqual([REPO]);
  });
});
