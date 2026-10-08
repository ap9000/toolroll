/**
 * A scheduled flow's limits (v115, what a routine's were): one at a time and the rolling 7-day ceiling count every task
 * the schedule filed, through each firing's own record — never through its card, whose task changes as it moves. The
 * ceiling anchors to when each provider started and fails closed on a paid run that recorded no cost.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type FlowTriggerRow, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { BUDGET_WINDOW_MS, createScheduledFlow } from "./flow-schedule.js";
import { runFlowTriggers, setFlowTriggerOn, type TriggerIo } from "./flow-triggers.js";
import { moveCardInFlow } from "./flow-engine.js";

const T0 = new Date("2026-10-08T12:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const io: TriggerIo = { gh: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, notFound: false }), fetch, dir: null };
const ACCEPTANCE = [{ id: "c1", statement: "The refreshed lockfile still installs cleanly.", how: null, evidence: ["check" as const] }];

let dir: string, repo: string, store: Store;
let flow: number, trigger: number;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-schedule-limits-")));
  repo = join(dir, "site");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "README.md"), "Site\n");
  store = openStore(join(dir, "orders.db"));
  if (!addApprover(store, "alex", T0).ok) throw new Error("approver");
  for (const phase of ["plan", "build", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "alex", T0);
  const made = createScheduledFlow(store, { repo, name: "Nightly deps", stem: "nightly-deps", schedule: "every:60", by: "alex", terms: {
    goal: "Refresh the dependency lockfile and note anything major", outOfScope: null, touches: ["package.json"], requirements: [], acceptance: ACCEPTANCE,
    budgetPerRunMicrousd: null, costCeilingUsd: 10,
  } }, T0);
  if (!made.ok) throw new Error(made.message);
  ({ flow, trigger } = made);
  setFlowTriggerOn(store, triggerRow(), true, T0);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

function triggerRow(): FlowTriggerRow {
  return store.flowTriggers(flow).find(one => one.id === trigger)!;
}
/** Fire the next due slot; the trigger's last outcome says what happened. */
async function fire(): Promise<string> {
  const due = Date.parse(triggerRow().nextAt!);
  expect((await runFlowTriggers(store, repo, new Date(due + 60_000), io)).problems).toEqual([]);
  return triggerRow().lastOutcome!;
}
/** A builder run on a task: its provider started at `started` and it cost `cost` (null: never recorded). */
function paidRun(taskId: string, started: Date, cost: number | null, opened = started): void {
  store.handle.prepare(`INSERT INTO run (task_ref, lease_id, runner, role, provider, model, branch, worktree, started_at, provider_started_at, finished_at, outcome, reason, cost_usd)
    VALUES (?, ?, 'r', 'builder', 'claude', 'sonnet', 'b', ?, ?, ?, ?, 'built', 'built', ?)`)
    .run(store.lookupRef(taskId)!.id, `lease-${started.getTime()}`, repo, opened.toISOString(), started.toISOString(), new Date(started.getTime() + 60_000).toISOString(), cost);
}
const cardOf = (taskId: string) => store.handle.prepare("SELECT c.id FROM flow_card c JOIN flow_trigger_event e ON e.card = c.id WHERE e.task = ?").get(taskId)!;
const firedTask = (outcome: string) => /^Filed ([a-z0-9-]+)/.exec(outcome)![1]!;

test("a finished $12 run still counts toward the $10 weekly limit after its card moves to Done", async () => {
  const first = firedTask(await fire());
  const card = store.getFlowCard(Number(cardOf(first)["id"]))!;
  expect(card.task).toBe(first);
  paidRun(first, at(70), 12);
  store.setTaskState(first, "done", at(75));
  expect(moveCardInFlow(store, card, "done", "alex", at(80)).ok).toBe(true);

  // The move cleared the card's task; the firing's own record still names it.
  expect(store.getFlowCard(card.id)!.task).toBeNull();
  expect(store.handle.prepare("SELECT task FROM flow_trigger_event WHERE trigger = ? AND card = ?").get(trigger, card.id)?.["task"]).toBe(first);
  expect(store.standingOrderSpend(trigger, null, new Date(at(90).getTime() - BUDGET_WINDOW_MS).toISOString())).toEqual({ costUsd: 12, unmeasuredRuns: 0 });
  expect(await fire()).toBe("Skipped: $12.00 of the $10.00 weekly limit is spent.");
  expect(store.handle.prepare("SELECT COUNT(*) AS n FROM flow_card WHERE flow = ?").get(flow)?.["n"]).toBe(1);
});

test("an unfinished task still blocks the next firing after a person moves its card on", async () => {
  const first = firedTask(await fire());
  const card = store.getFlowCard(Number(cardOf(first)["id"]))!;
  const state = store.getTask(first)!.state;
  expect(["done", "cancelled"]).not.toContain(state);
  expect(moveCardInFlow(store, card, "done", "alex", at(80)).ok).toBe(true);
  expect(store.getFlowCard(card.id)!.task).toBeNull();

  expect(await fire()).toBe(`Skipped: the last one (${first}, ${state}) hasn't finished.`);
  expect(store.handle.prepare("SELECT COUNT(*) AS n FROM flow_card WHERE flow = ?").get(flow)?.["n"]).toBe(1);
  // Finished, it no longer blocks: the next slot files again.
  store.setTaskState(first, "done", at(150));
  expect(await fire()).toMatch(/^Filed nightly-deps-/);
});

test("the weekly window anchors to when each provider started, not when its run row opened", async () => {
  const first = firedTask(await fire());
  store.setTaskState(first, "done", at(75));
  const now = Date.parse(triggerRow().nextAt!) + 60_000;
  // Opened eight days before the window, but its provider started inside it: it counts.
  paidRun(first, new Date(now - BUDGET_WINDOW_MS + 60 * 60_000), 6, new Date(now - BUDGET_WINDOW_MS - 24 * 60 * 60_000));
  // Its provider started just outside the window: it doesn't.
  paidRun(first, new Date(now - BUDGET_WINDOW_MS - 60_000), 50);
  expect(store.standingOrderSpend(trigger, null, new Date(now - BUDGET_WINDOW_MS).toISOString())).toEqual({ costUsd: 6, unmeasuredRuns: 0 });
  expect(await fire()).toMatch(/^Filed nightly-deps-/);
});

test("a paid run that recorded no cost fails the weekly limit closed until its cost lands", async () => {
  const first = firedTask(await fire());
  store.setTaskState(first, "done", at(75));
  const card = store.getFlowCard(Number(cardOf(first)["id"]))!;
  expect(moveCardInFlow(store, card, "done", "alex", at(80)).ok).toBe(true);
  paidRun(first, at(70), null);
  expect(await fire()).toBe("Skipped: 1 run(s) in the last 7 days recorded no cost, so the $10.00 weekly limit can't be kept.");
  // The cost lands, over the limit: now it is a plain limit skip.
  store.handle.prepare("UPDATE run SET cost_usd = 12.5 WHERE cost_usd IS NULL").run();
  expect(await fire()).toBe("Skipped: $12.50 of the $10.00 weekly limit is spent.");
});
