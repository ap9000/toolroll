/**
 * One set of agent states (docs/plans/agents-cockpit.md §1): the display state from four separate facts, the roll-up,
 * and a project's complete counts for one person — obligations without a run, attempts of every role, failures that
 * stay until dealt with, unseen good finishes that looking clears, and only the projects that person may see.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { displayStateOf, NO_COUNTS, projectStates, rollUp, type StateFacts } from "./agent-state.js";
import { attemptKeyOf, markAgentSeen, recordAgentTurn, STUCK_AFTER_MS } from "./agent-board.js";
import { propose } from "./scope.js";
import { BUILT_IN, openStore, type Store } from "./store.js";

const T0 = new Date("2026-10-19T12:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const SHOP = "/projects/shop", OPS = "/projects/ops";

describe("the display state", () => {
  const facts = (over: Partial<StateFacts>): StateFacts => ({ activity: "finished", outcome: "built", obligation: false, unread: false, ...over });
  test.each([
    [{ obligation: true, activity: "running" }, "needs-you"],
    [{ obligation: true, outcome: "failed" }, "needs-you"],
    [{ outcome: "failed" }, "failed"],
    [{ outcome: "failed", unread: false }, "failed"],
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

  test("looking clears only a good finish: a failure, an obligation and a checks failure stay", () => {
    for (const unread of [true, false]) {
      expect(displayStateOf(facts({ outcome: "failed", unread }))).toBe("failed");
      expect(displayStateOf(facts({ outcome: "checks-failed", unread }))).toBe("failed");
      expect(displayStateOf(facts({ obligation: true, unread }))).toBe("needs-you");
    }
    expect(displayStateOf(facts({ outcome: "built", unread: true }))).toBe("done");
    expect(displayStateOf(facts({ outcome: "built", unread: false }))).toBe("idle");
  });

  test("the roll-up takes the strongest state present, in order, and nothing counted is idle", () => {
    expect(rollUp({ ...NO_COUNTS })).toEqual({ state: "idle", counts: NO_COUNTS });
    expect(rollUp({ ...NO_COUNTS, working: 3, done: 1 }).state).toBe("working");
    expect(rollUp({ ...NO_COUNTS, working: 3, failed: 1 }).state).toBe("failed");
    expect(rollUp({ ...NO_COUNTS, failed: 2, "needs-you": 1 }).state).toBe("needs-you");
    expect(rollUp({ ...NO_COUNTS, stuck: 1, paused: 1, working: 1 }).state).toBe("stuck");
  });
});

describe("a project's counts", () => {
  let store: Store, dir: string;
  beforeEach(() => { store = openStore(":memory:"); dir = mkdtempSync(join(tmpdir(), "so-state-")); });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  const task = (id: string, repo = SHOP) => {
    store.createTask({ id, title: id }, T0);
    const ref = store.refFor(BUILT_IN, id).id;
    store.placeTask(ref, repo);
    return ref;
  };
  const start = (ref: number, lease: string, role: "builder" = "builder") =>
    store.startRun({ taskRef: ref, leaseId: lease, runner: "builder-1", branch: `b-${lease}`, worktree: dir, provider: "claude", now: T0, route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, ...(role === "builder" ? {} : {}) });
  const acceptance = [{ id: "c1", statement: "It works.", evidence: ["manual-review" as const], how: null }];
  // Read well past the stuck line, so a build quiet since it started is stuck and one active just now is not.
  const NOW = at(STUCK_AFTER_MS + 10 * 60_000);
  const counts = (account = "alex", repos: string[] | null = null) => Object.fromEntries(projectStates(store, { repos }, account, NOW).map(one => [one.repo, one]));

  test("an approval with no run yet, a question, a failure, work running and stuck, work waiting, and an unseen finish each count", () => {
    // A plan waiting for approval, with no run of any kind yet.
    task("approve-me");
    propose(store, { taskId: "approve-me", goal: "Round refunds", outOfScope: null, touches: [], acceptance, now: T0 });
    // A failed task nothing is working on.
    task("broke");
    store.setTaskState("broke", "failed", T0);
    // A build running, and one gone quiet past the stuck line.
    const running = task("running");
    const live = start(running, "l-run");
    recordAgentTurn(store, { run: live, attemptKey: attemptKeyOf(store, live)!, state: "busy", at: new Date(NOW.getTime() - 30_000) });
    const quiet = task("quiet");
    const silent = start(quiet, "l-quiet");
    recordAgentTurn(store, { run: silent, attemptKey: attemptKeyOf(store, silent)!, state: "busy", at: T0 });
    // The running build asks a question: an obligation of its own, while the attempt works on.
    store.handle.prepare("INSERT INTO agent_question (run, task_ref, attempt_key, key, question, asked_at) VALUES (?, ?, ?, 'q1', 'Which currency?', ?)")
      .run(live, running, attemptKeyOf(store, live)!, T0.toISOString());
    // Approved and queued, nothing running.
    task("queued");
    propose(store, { taskId: "queued", goal: "Queue", outOfScope: null, touches: [], acceptance, now: T0 });
    store.handle.prepare("UPDATE task_scope SET approved_at = ?, approved_by = 'alex', approved_digest = digest WHERE task_id = 'queued'").run(T0.toISOString());
    // Finished well, not yet seen.
    const finished = task("finished");
    const done = start(finished, "l-done");
    store.finishRun(done, { outcome: "built", now: at(10_000) });

    const shop = counts()[SHOP]!;
    expect(shop.counts).toMatchObject({ "needs-you": 2, failed: 1, working: 1, stuck: 1, waiting: 1, done: 1 });
    expect(shop.state).toBe("needs-you");

    // Looking at the finish clears it — for that person only.
    markAgentSeen(store, "alex", done, at(20_000));
    expect(counts("alex")[SHOP]!.counts.done).toBe(0);
    expect(counts("sam")[SHOP]!.counts.done).toBe(1);
    // Looking never clears the failure.
    expect(counts("alex")[SHOP]!.counts.failed).toBe(1);
  });

  test("a failure no longer leads once a newer version is filed or an attempt is working on it", () => {
    const ref = task("broke");
    store.setTaskState("broke", "failed", T0);
    expect(counts()[SHOP]!.counts.failed).toBe(1);
    start(ref, "l-retry");
    expect(counts()[SHOP]!.counts).toMatchObject({ failed: 0, working: 1 });
  });

  test("only the projects a person may see are counted, and an empty project is idle", () => {
    task("shop-broke", SHOP);
    store.setTaskState("shop-broke", "failed", T0);
    task("ops-broke", OPS);
    store.setTaskState("ops-broke", "failed", T0);
    expect(Object.keys(counts("alex", null)).sort()).toEqual([OPS, SHOP]);
    expect(Object.keys(counts("sam", [SHOP]))).toEqual([SHOP]);
    expect(projectStates(store, { repos: [] }, "sam", T0)).toEqual([]);
  });
});
