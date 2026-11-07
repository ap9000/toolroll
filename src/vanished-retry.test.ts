/**
 * P2.1 must-refuse rules, against the real store: a run is charged once, whoever recovers it; a retry stays inside its
 * episode's attempt and spend limits, under concurrent recoverers and a crash; a stopped, held, archived or no-longer
 * approved task is not retried; a plan with no budget is not retried.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { register } from "./runner.js";
import { acquire, MAX_STRIKES } from "./claim.js";
import { addApprover, approve, propose } from "./scope.js";
import { requestTaskStop } from "./task-control.js";
import { routeDigestOf } from "./phase-routing.js";
import { diagnoseTaskDispatch, taskReadinessBlocker } from "./dispatch.js";
import { RETRY_LIMIT, retryVanishedWhenStopped, settleVanished, VANISHED_MAX_STRIKES, vanishedStopOf } from "./vanished-retry.js";

const REPO = "/repos/vanish";
const NOW = new Date("2026-11-06T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
const BUDGET = 2_000_000;
let dir: string;
let file: string;
let store: Store;
let token: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-vanish-"));
  file = join(dir, "orders.db");
  store = openStore(file);
  const owner = addApprover(store, "owner", NOW);
  if (!owner.ok) throw new Error("no owner");
  token = owner.token;
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "owner", NOW);
  register(store, { name: "worker", host: "fixture", capacity: 4, repos: [REPO], now: NOW, newToken: () => "worker-token" });
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

function approved(id: string, budget: number | null, candidate?: string): number {
  store.createTask({ id, title: id }, NOW);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, REPO, {}, NOW);
  const scope = propose(store, { taskId: id, goal: "Fix the footer.", touches: ["src/footer.ts"], budgetMicrousd: budget, acceptance: [{ id: "c1", statement: "It reads right.", how: null, evidence: ["check"] }], now: NOW, ...(candidate === undefined ? {} : { candidate }) });
  const yes = approve(store, id, "owner", NOW, scope.digest, token);
  if (!yes.ok) throw new Error(JSON.stringify(yes));
  return ref;
}

/** Claim and start one attempt: the runner then dies with it. */
function attempt(ref: number, when: Date): { run: number; lease: string } {
  const claim = acquire(store, ref, "worker", { token: "worker-token", now: when });
  if (!claim.ok) throw new Error(JSON.stringify(claim));
  const sealed = store.sealedRouteOf(store.refForId(ref)!.externalId);
  if (!sealed.ok) throw new Error(JSON.stringify(sealed));
  const run = store.startRun({ taskRef: ref, runner: "worker", leaseId: claim.claim.leaseId, worktree: REPO, branch: "b", now: when, model: "sonnet",
    scopeDigest: store.getScope(store.refForId(ref)!.externalId)!.digest,
    route: { routeDigest: routeDigestOf(sealed.route), phase: "build", provider: "claude", model: "sonnet", chosen: "recommended" } });
  return { run, lease: claim.claim.leaseId };
}
const strikes = (ref: number) => store.refForId(ref)?.strikes;
const episode = (ref: number) => store.handle.prepare("SELECT retries, reserved_microusd, stopped FROM retry_episode WHERE task_ref = ?").get(ref);
const vanish = (when: Date) => { store.releaseClaimsOf("worker", when); return store.recoverRunnerWork("worker", when); };

describe("the charge", () => {
  test("the limit here is the claim road's", () => expect(VANISHED_MAX_STRIKES).toBe(MAX_STRIKES));

  test("a vanished run is charged once, whoever recovers it and however often", () => {
    const ref = approved("once", BUDGET);
    attempt(ref, at(1));
    store.handle.prepare("UPDATE claim SET incarnation = 'gone'").run();
    store.releaseClaimsOf("worker", at(2));
    store.recoverRunnerWork("worker", at(3));
    store.recoverIncarnation("worker", "gone", at(4));
    store.recoverRunnerWork("worker", at(5));
    expect(strikes(ref)).toBe(1);
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM vanished_charge").get()?.["n"]).toBe(1);
    expect(store.getTask("once")?.state).toBe("queued");
  });

  test("a second connection recovering the same runner charges nothing more", () => {
    const ref = approved("twice", BUDGET);
    attempt(ref, at(1));
    const other = openStore(file);
    try {
      store.releaseClaimsOf("worker", at(2));
      store.recoverRunnerWork("worker", at(2));
      other.recoverRunnerWork("worker", at(2));
      expect(strikes(ref)).toBe(1);
      expect(episode(ref)).toMatchObject({ retries: 1, reserved_microusd: 2 * BUDGET });
    } finally { other.close(); }
  });

  test("a crash between the charge and the requeue leaves neither, and the next recovery charges once", () => {
    const ref = approved("crash", BUDGET);
    const { run } = attempt(ref, at(1));
    expect(() => store.transact(() => { vanish(at(2)); throw new Error("power cut"); })).toThrow("power cut");
    expect(strikes(ref)).toBe(0);
    expect(store.getRun(run)?.outcome).toBeNull();
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM vanished_charge").get()?.["n"]).toBe(0);
    expect(episode(ref)).toBeUndefined();
    vanish(at(3));
    expect(strikes(ref)).toBe(1);
    expect(store.getTask("crash")?.state).toBe("queued");
  });
});

describe("the limits", () => {
  test("a plan with no budget gets no retry: the task waits for a person, with its words", () => {
    const ref = approved("free", null);
    const { run } = attempt(ref, at(1));
    vanish(at(2));
    expect(store.getTask("free")?.state).toBe("failed");
    expect(vanishedStopOf(store, ref)).toEqual({ why: "no-budget", run });
    expect(diagnoseTaskDispatch(store, "free", at(3))).toMatchObject({ detail: `Build #${run} stopped unexpectedly. Retry it.`, action: "retry-task" });
  });

  test("each claim reserves its budget: the spend ceiling stops the second retry, whatever the strikes say", () => {
    const ref = approved("spend", BUDGET);
    attempt(ref, at(1));
    vanish(at(2));
    expect(store.getTask("spend")?.state).toBe("queued");
    expect(episode(ref)).toMatchObject({ retries: 1, reserved_microusd: 2 * BUDGET });
    store.resetStrikes(ref); // a built attempt in between never buys more of the episode's money
    const second = attempt(ref, at(3));
    vanish(at(4));
    expect(store.getTask("spend")?.state).toBe("failed");
    expect(vanishedStopOf(store, ref)).toEqual({ why: "spend", run: second.run });
    expect(diagnoseTaskDispatch(store, "spend", at(5))).toMatchObject({ detail: `Build #${second.run} keeps stopping. Retry, or change the plan.` });
  });

  test("a prepared candidate spends nothing, so it needs no budget, and its attempts still stop", () => {
    const ref = approved("check", null, "a".repeat(40));
    for (let round = 1; round <= RETRY_LIMIT; round++) {
      attempt(ref, at(round * 10));
      vanish(at(round * 10 + 1));
      if (round < MAX_STRIKES) expect(store.getTask("check")?.state).toBe("queued");
      else expect(vanishedStopOf(store, ref)?.why).toBe("attempts");
    }
    expect(store.getTask("check")?.state).toBe("failed");
  });

  test("the attempt limit holds even when strikes were reset between attempts", () => {
    const ref = approved("reset", null, "b".repeat(40));
    for (let round = 1; round <= RETRY_LIMIT; round++) {
      attempt(ref, at(round * 10));
      vanish(at(round * 10 + 1));
      expect(store.getTask("reset")?.state).toBe("queued");
      store.resetStrikes(ref);
    }
    expect(episode(ref)).toMatchObject({ retries: RETRY_LIMIT });
    attempt(ref, at(100));
    vanish(at(101));
    expect(vanishedStopOf(store, ref)?.why).toBe("attempts");
    expect(store.getTask("reset")?.state).toBe("failed");
  });

  test("strikes from ordinary failures count: the third strike stops the retry", () => {
    const ref = approved("struck", BUDGET * 10);
    store.handle.prepare("UPDATE task_ref SET strikes = 2 WHERE id = ?").run(ref);
    attempt(ref, at(1));
    vanish(at(2));
    expect(strikes(ref)).toBe(3);
    expect(vanishedStopOf(store, ref)?.why).toBe("attempts");
  });

  test("a person's Retry starts a new episode, and clears the need", () => {
    const ref = approved("again", null);
    attempt(ref, at(1));
    vanish(at(2));
    expect(store.requeueTask("again", "owner", at(3)).ok).toBe(true);
    expect(store.getTask("again")?.state).toBe("queued");
    expect(strikes(ref)).toBe(0);
    expect(episode(ref)).toBeUndefined();
    expect(vanishedStopOf(store, ref)).toBeNull();
  });
});

describe("what blocks a retry", () => {
  test("a person's stop: no charge, no retry, its pause stands", () => {
    const ref = approved("stopped", BUDGET);
    const { run } = attempt(ref, at(1));
    expect(requestTaskStop(store, { taskId: "stopped", runId: run, by: "owner", via: "web" }, at(2)).ok).toBe(true);
    vanish(at(3));
    expect(strikes(ref)).toBe(0);
    expect(episode(ref)).toBeUndefined();
    expect(taskReadinessBlocker(store, ref, at(4))).toMatchObject({ code: "hold", ownerKind: "stop" });
  });

  test("a hold: charged, nothing reserved, and it does not dispatch", () => {
    const ref = approved("held", BUDGET);
    attempt(ref, at(1));
    store.holdOwned({ taskRef: ref, ownerKind: "operator", ownerId: "owner", reason: "not now", until: null }, at(2));
    vanish(at(3));
    expect(strikes(ref)).toBe(1);
    expect(episode(ref)).toBeUndefined();
    expect(taskReadinessBlocker(store, ref, at(4))).toMatchObject({ code: "hold" });
  });

  test("an archived task does not dispatch", () => {
    const ref = approved("away", BUDGET);
    attempt(ref, at(1));
    store.handle.prepare("INSERT INTO task_archive (task_ref, by, by_kind, reason, at) VALUES (?, 'owner', 'person', 'done with it', ?)").run(ref, at(2).toISOString());
    vanish(at(3));
    expect(episode(ref)).toBeUndefined();
    expect(taskReadinessBlocker(store, ref, at(4))).toMatchObject({ code: "archived" });
  });

  test("a plan rewritten after approval is not retried on the old yes", () => {
    const ref = approved("rewritten", BUDGET);
    attempt(ref, at(1));
    store.handle.prepare("UPDATE task_scope SET digest = 'changed' WHERE task_id = 'rewritten'").run();
    vanish(at(2));
    expect(episode(ref)).toBeUndefined();
    expect(acquire(store, ref, "worker", { token: "worker-token", now: at(3) }).ok).toBe(true); // the raw claim road takes no view…
    store.handle.prepare("UPDATE claim SET released_at = ?").run(at(3).toISOString());
    store.handle.prepare("UPDATE task SET state = 'queued' WHERE id = 'rewritten'").run();
    expect(diagnoseTaskDispatch(store, "rewritten", at(4))).toMatchObject({ code: "needs-approval" }); // …the dispatch road does
  });

  test("a process not proven stopped holds the decision until it is, and the retry never starts beside it", () => {
    const ref = approved("alive", BUDGET);
    const { run } = attempt(ref, at(1));
    store.handle.prepare("UPDATE run SET provider_started_at = ? WHERE id = ?").run(at(1).toISOString(), run);
    vanish(at(2));
    expect(strikes(ref)).toBe(1);
    expect(episode(ref)).toBeUndefined();
    expect(retryVanishedWhenStopped(store, at(3))).toBe(0);
    expect(taskReadinessBlocker(store, ref, at(3))).toMatchObject({ code: "hold", ownerKind: "backoff", until: null });
    store.handle.prepare("INSERT INTO run_process_summary (run, witnesses, process_groups, first_observed_at, last_observed_at, last_exited_at, settled_at) VALUES (?, 1, 1, ?, ?, ?, ?)").run(run, at(1).toISOString(), at(1).toISOString(), at(4).toISOString(), at(4).toISOString());
    expect(retryVanishedWhenStopped(store, at(5))).toBe(1);
    expect(store.getTask("alive")?.state).toBe("queued");
    expect(taskReadinessBlocker(store, ref, at(5))).toBeNull();
    expect(strikes(ref)).toBe(1);
    expect(episode(ref)).toMatchObject({ retries: 1 });
  });

  test("a task the CLI moved to running is settled the same way, and a person's act isn't needed to unstick it", () => {
    const ref = approved("cli", BUDGET);
    attempt(ref, at(1));
    store.setTaskState("cli", "running", at(1));
    vanish(at(2));
    expect(store.getTask("cli")?.state).toBe("queued");
    expect(strikes(ref)).toBe(1);
  });

  test("a hand-back and a recovery pass over a decided run decide nothing again", () => {
    const ref = approved("decided", BUDGET);
    attempt(ref, at(1));
    vanish(at(2));
    expect(episode(ref)).toMatchObject({ retries: 1 });
    expect(settleVanished(store, ref, at(3))).toBe("none");
    expect(episode(ref)).toMatchObject({ retries: 1, reserved_microusd: 2 * BUDGET });
  });

  test("a live lease elsewhere owns the task: nothing moves", () => {
    const ref = approved("owned", BUDGET);
    attempt(ref, at(1));
    expect(settleVanished(store, ref, at(2))).toBe("none");
    expect(strikes(ref)).toBe(0);
  });
});
