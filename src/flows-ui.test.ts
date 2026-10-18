import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { htmlString } from "./html.js";
import { flowTaskFixture } from "../test/flow-card-task.js";
import { createScheduledFlow } from "./flow-schedule.js";
import { flowFallbackHtml, flowView } from "./flows-ui.js";
import { signUnattended } from "./flow-unattended.js";
import { openStore, type Store } from "./store.js";

const now = new Date("2026-10-07T17:00:00Z");
let store: Store, fixture: ReturnType<typeof flowTaskFixture>;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); store = openStore(":memory:"); fixture = flowTaskFixture(store, now); });
afterEach(() => { store.close(); vi.useRealTimers(); });
const view = () => flowView(store, store.getFlow(fixture.flow)!, { name: "alex", approver: true }, null);

test("agent cards and the fallback read live task progress and keep the task link", () => {
  fixture.checkpoint(["completed", "completed", "current", "pending", "pending", "pending"]);
  const shown = view();
  expect(shown.cards[0]).toMatchObject({ waiting: "Building · step 3 of 6", task: { id: fixture.id, href: `/t/${fixture.id}` } });
  expect(htmlString(flowFallbackHtml(shown))).toContain("Building · step 3 of 6");
  expect(store.getFlowCard(fixture.card)!.waiting).toBe("Filed as a task");
  fixture.question();
  expect(view().cards[0]!.waiting).toBe("Waiting on you: Use banker's rounding for refunds too?");
});

test("later zones keep their own waiting state instead of the previous task's progress", () => {
  fixture.checkpoint(["blocked"], "Staging is unavailable");
  store.moveFlowCard(fixture.card, { to: "review", outcome: "moved", actor: "alex" }, now);
  store.updateFlowCard(fixture.card, { waiting: "Waiting for your approval" }, now);
  expect(view().cards[0]).toMatchObject({ waiting: "Waiting for your approval", canDecide: true });
});

test("cross-project task progress is shown only when that project is admitted", () => {
  const other = "/repo/refunds";
  const flow = store.createFlow({ repo: other, name: "Refunds", by: "alex", definitionJson: store.getFlow(fixture.flow)!.definitionJson }, now);
  const card = store.addFlowCard({ flow, title: "Round refunds", description: null, stage: "build", by: "alex" }, now);
  store.updateFlowCard(card, { task: fixture.id, waiting: "Filed as a task" }, now);
  fixture.checkpoint(["blocked"], "Refund service is unavailable");
  expect(flowView(store, store.getFlow(flow)!, { name: "alex", approver: true }, null).cards[0]!.waiting).toBe("Task unavailable");
  const shown = flowView(store, store.getFlow(flow)!, { name: "alex", approver: true }, null, { dir: null, repos: [fixture.repo, other] });
  expect(shown.cards[0]!.waiting).toBe("Stuck: Refund service is unavailable");
});

test("a card without a task keeps its filing error, and an empty zone stays empty", () => {
  store.updateFlowCard(fixture.card, { task: null, waiting: "Couldn't file the work: the backlog is full" }, now);
  expect(view().cards[0]!.waiting).toBe("Couldn't file the work: the backlog is full");
  expect(view().cards.filter(card => card.stage === "empty")).toEqual([]);
});

test("a scheduled flow's trigger says it's paused and what each run files, on demand", () => {
  const made = createScheduledFlow(store, { repo: "/repo/sched", name: "Nightly deps", stem: "nightly-deps", schedule: "daily:03:30", by: "alex",
    terms: { goal: "Refresh the lockfile.", outOfScope: "No major bumps.", touches: [], requirements: [], acceptance: [{ id: "c1", statement: "The suite passes.", how: null, evidence: ["check"] }], budgetPerRunMicrousd: null, costCeilingUsd: 5 } }, now);
  if (!made.ok) throw new Error(made.message);
  const [trigger] = flowView(store, store.getFlow(made.flow)!, { name: "alex", approver: true }, null).triggers;
  expect(trigger).toMatchObject({ state: "paused", name: "Daily at 03:30", detail: "Files “Nightly deps”" });
  expect(trigger!.order).toEqual(["Builds: Refresh the lockfile.", "Not this: No major bumps.", "Every 7 days: up to $5.00", "One at a time: it skips while the last one is unfinished.", "Each run waits for approval under the project's rules."]);
});

test("runs on its own: the view and the fallback page say until when, and who can't sign reads why", async () => {
  const flow = store.getFlow(fixture.flow)!;
  expect(view().unattended).toMatchObject({ active: null, canSign: false, scheduled: false, problem: "This flow has no schedule, so nothing would run on its own." });
  store.addFlowTrigger({ flow: flow.id, kind: "schedule", configJson: JSON.stringify({ kind: "schedule", schedule: "daily 09:00", title: "Checkout", description: null, zone: null }), hookHash: null, cursor: null, nextAt: null, by: "alex" }, now);
  expect(view().unattended).toMatchObject({ active: null, canSign: true, scheduled: true, schedules: [{ words: "“Checkout”, daily 09:00", optional: null }] });
  expect(view().unattended.terms.head[0]).toBe("Cards this flow's own schedule adds file their work approved by alex, without waiting in Needs you.");
  const signed = await signUnattended(store, { flow: flow.id, signer: "alex", ask: { days: 2, budgetMicrousd: null, dailyRunCap: 3 } }, now);
  if (!signed.ok) throw new Error(signed.message);
  const shown = view();
  expect(shown.unattended.active).toMatchObject({ until: "2026-10-09T17:00:00.000Z", untilWords: "Oct 9, 17:00 UTC", signedBy: "alex", dailyRunCap: 3, runsToday: 0, covers: ["“Checkout”, daily 09:00"] });
  expect(htmlString(flowFallbackHtml(shown))).toContain("Runs on its own until Oct 9, 17:00 UTC");
  expect(flowView(store, flow, { name: "alex", approver: false }, null).unattended).toMatchObject({ canSign: false, problem: "Only an approver can change this." });
  // Past its end, by the page's clock, it isn't shown as running.
  expect(flowView(store, flow, { name: "alex", approver: true }, null, { dir: null, repos: [], now: new Date("2026-10-09T17:00:00Z") }).unattended.active).toBeNull();
});
