/** Needs you is honest (docs/plans/plain-toolroll.md P1.2): every code is a need, a wait or a plain state, never two;
 * each need keeps the act it has always had; a wait is never Needs you and pings no phone. Over a seeded throwaway
 * store, a stopping build reads Waiting and a vanished build reads one plain need over its own act. */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { openStore, type Store } from "./store.js";
import { register } from "./runner.js";
import { addApprover, approve, propose } from "./scope.js";
import { ACTIVITY_ONLY_KINDS, CODE_READING, NEEDS, WAITS } from "./needs-you.js";
import { WAITING_CODES, workIndexPage } from "./work-index.js";

const NOW = new Date("2026-11-05T12:00:00.000Z");
const REPO = "/repos/needs-reading";

describe("the code table", () => {
  test("every code is exactly one of a need, a wait or a state, and its stage says which", () => {
    for (const [code, reading] of Object.entries(CODE_READING)) {
      expect(reading.need !== undefined && reading.wait !== undefined, code).toBe(false);
      expect(reading.stage === "waiting", `${code}: waiting ⇔ a wait`).toBe(reading.wait !== undefined);
      if (reading.stage === "needs-you") expect(reading.need, code).toBeDefined();
      if (reading.need !== undefined) expect(NEEDS[reading.need], code).toBeDefined();
      if (reading.wait !== undefined) expect(WAITS[reading.wait], code).toBeDefined();
    }
  });

  test("each work-index code keeps the act it had before: no act changed, only words", () => {
    const acts: Record<string, string | null> = {
      "history-problem": "inspect-task", "earlier-active": "inspect-task", "ready-to-check": "open-result", complete: "open-result", cancelled: "inspect-task",
      running: null, "waiting-decision": "answer-decision", "decision-queue": "inspect-decisions", "result-needs-attention": "inspect-run",
      "process-needs-attention": "inspect-run", failed: "retry-task", "vanished-run": "reconcile-run", stopped: "resume-run", held: "inspect-hold",
      "waiting-incident": "retry-task", "terminal-dependency": "repair-dependency", "waiting-dependency": null, "needs-project": "place-task",
      "needs-scope": "write-scope", "invalid-scope": "write-scope", "needs-agent-profile": "select-agent", "needs-approval": "approve-scope",
      "missing-requirement": "repair-capability", "no-worker-registered": "start-worker", "no-worker-online": "start-worker", "worker-at-capacity": null,
      "signed-out": "sign-in", "retry-scheduled": null, updating: null, "planning-ready": null, "scouting-ready": null, queued: null,
    };
    for (const [code, act] of Object.entries(acts)) expect(CODE_READING[code]?.act ?? null, code).toBe(act);
  });

  test("the waits P1.2 names are waits, and the work index counts no Needs you for any wait", () => {
    for (const code of ["stopping", "planning-ready", "scouting-ready", "worker-at-capacity", "retry-scheduled"]) {
      expect(CODE_READING[code]?.stage, code).toBe("waiting");
      expect(WAITING_CODES, code).toContain(code);
    }
    for (const [code, reading] of Object.entries(CODE_READING)) if (reading.stage === "waiting" && code !== "build-stopping" && code !== "other-computer") expect(WAITING_CODES, code).toContain(code);
    // The needs P1.2 names stay needs, over their own acts.
    for (const code of ["vanished-run", "no-worker-online", "earlier-active", "history-problem"]) expect(CODE_READING[code]?.stage, code).toBe("needs-you");
    expect(CODE_READING["waiting-incident"]).toMatchObject({ stage: "failed", act: "retry-task" });
  });

  test("a fact that needs nothing pings no phone", () => {
    expect(ACTIVITY_ONLY_KINDS.has("check-progress")).toBe(true);
  });
});

describe("over the work index", () => {
  let store: Store, password = "";
  const runs: Record<string, number> = {};
  function started(id: string): number {
    store.createTask({ id, title: id }, NOW);
    const ref = store.refFor("built-in", id).id;
    store.placeTask(ref, REPO, {}, NOW);
    const proposed = propose(store, { taskId: id, goal: `Do ${id}`, touches: ["src/a.ts"], acceptance: [{ id: "c1", statement: "it works", how: null, evidence: ["check"] }], now: NOW });
    const ok = approve(store, id, "sam", NOW, proposed.digest, password);
    if (!ok.ok) throw new Error(ok.reason);
    const authority = store.routeAuthorityFor(ref, "builder");
    if (!authority?.ok) throw new Error("route");
    const run = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "builder-1", branch: `b/${id}`, worktree: `/pool/${id}`, route: authority.stamp, now: NOW });
    runs[id] = run;
    store.setTaskState(id, "running", NOW);
    return run;
  }
  beforeAll(() => {
    store = openStore(":memory:");
    register(store, { name: "builder-1", host: "test", capacity: 4, repos: [REPO], now: NOW, newToken: () => "tok" });
    for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", NOW);
    const sam = addApprover(store, "sam", NOW);
    if (!sam.ok) throw new Error("sam");
    password = sam.token;
    const stopping = started("stopping-one");
    store.raw().prepare("INSERT INTO run_stop (run, task_ref, requested_by, requested_via, requested_at) VALUES (?, ?, 'sam', 'cli', ?)").run(stopping, store.refFor("built-in", "stopping-one").id, NOW.toISOString());
    started("vanished-one");
  });
  afterAll(() => store.close());
  const page = (view: "all" | "needs-you" = "all") => workIndexPage(store, NOW, { principal: "operator", repos: [REPO] }, { view }).items;

  test("a stopping build reads Waiting, says what Toolroll is doing, and is not Needs you", () => {
    const row = page().find(one => one.rootId === "stopping-one")!;
    expect(row.status.label).toBe("Waiting");
    expect(row.status.detail).toBe(`Waiting: Toolroll is stopping build #${runs["stopping-one"]}.`);
    expect(row.ask).toBeNull();
    expect(page("needs-you").some(one => one.rootId === "stopping-one")).toBe(false);
  });

  test("a vanished build reads one plain need over the act it always had", () => {
    const row = page("needs-you").find(one => one.rootId === "vanished-one")!;
    expect(row.status.label).toBe("Needs you");
    expect(row.status.detail).toBe(`Build #${runs["vanished-one"]} stopped unexpectedly. Retry it.`);
    expect(row.primaryAction).toMatchObject({ code: "reconcile-run", target: { runId: runs["vanished-one"] } });
  });
});
