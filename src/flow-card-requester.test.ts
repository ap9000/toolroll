/**
 * v126: who made a card is decided where it was made and filed exactly as kept — never read from the card's name.
 * A signed-in account adding a card is the task's requester whatever its name looks like ("hook:sentry", "Maya (AI)",
 * "coordinator:pat"); a chat channel's message is the app's word, not an account, and files as automation.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { flowFromSteps } from "./flows.js";
import { addCardToFlow, advanceFlows } from "./flow-engine.js";
import { takeChannelMessage } from "./chat-inbox.js";

const REPO = "/test/shop";
const T0 = new Date("2026-10-19T12:00:00.000Z");

let dir: string, store: Store, flow: number;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-card-requester-")));
  store = openStore(join(dir, "orders.db"));
  if (!addApprover(store, "alex", T0).ok) throw new Error("bootstrap");
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "alex", T0);
  flow = store.createFlow({ repo: REPO, name: "Fixes", by: "alex", definitionJson: JSON.stringify(flowFromSteps([{ title: "Build it", kind: "task", instructions: "Fix it: {{card.title}}" }], null)) }, T0);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

/** The task one card filed, once the engine has passed. */
function filedFrom(card: number): string {
  advanceFlows(store, REPO, T0);
  const task = store.getFlowCard(card)?.task;
  if (task == null) throw new Error(`card ${card} filed nothing: ${store.getFlowCard(card)?.waiting}`);
  return task;
}

test.each(["hook:sentry", "Maya (AI)", "coordinator:pat"])("an account named %s adding a card by hand is its task's requester", name => {
  const added = addCardToFlow(store, store.getFlow(flow)!, { title: "Checkout rounding", description: null, stage: null }, name, T0);
  if (!added.ok) throw new Error(added.message);
  const card = store.handle.prepare("SELECT id FROM flow_card WHERE flow = ? ORDER BY id DESC LIMIT 1").get(flow)!["id"] as number;
  expect(store.getFlowCard(card)?.createdKind).toBe("person");
  const task = filedFrom(card);
  expect(store.taskFiler(task)).toEqual({ name, kind: "person" });
  // Under "not the requester", their own approval is refused — through chat (the gate planInChat and the chat seal ask,
  // kind "mode") and on the console — by name, whatever the name looks like; another approver's goes through.
  expect(store.requestersOf(task).has(name)).toBe(true);
  store.setApprovalRules(REPO, { notRequester: true, protectProject: false, protectedPaths: [] }, "alex", T0);
  expect(store.approvalGate(task, name, "mode")).toEqual({ verdict: "refuse", reason: "requester" });
  expect(store.approvalGate(task, name, "person")).toEqual({ verdict: "refuse", reason: "requester" });
  expect(store.approvalGate(task, "alex", "mode")).toEqual({ verdict: "seal", protectedWork: false });
});

test("a chat channel's message files as automation: no account named after the app becomes its requester", () => {
  const trigger = store.addFlowTrigger({ flow, kind: "chat", by: "alex", hookHash: null, cursor: null, nextAt: null,
    configJson: JSON.stringify({ kind: "chat", app: "slack", installation: "T1", chat: "C1", binding: 1, zone: null }) }, T0);
  takeChannelMessage(store, store.getFlowTrigger(trigger)!, { app: "slack", conversation: "C1", ts: "1.0", thread: "1.0", text: "The header is cramped on phones", who: "sam" }, T0);
  const card = store.flowTriggerCard(trigger, "msg:1.0")!;
  expect(store.getFlowCard(card)).toMatchObject({ createdBy: "Slack", createdKind: "automation" });
  const task = filedFrom(card);
  expect(store.taskFiler(task)).toEqual({ name: "Slack", kind: "automation" });
  expect(store.requestersOf(task).has("Slack")).toBe(false);
  // An unrelated account that happens to be called Slack may approve it under "not the requester".
  store.setApprovalRules(REPO, { notRequester: true, protectProject: false, protectedPaths: [] }, "alex", T0);
  expect(store.approvalGate(task, "Slack", "mode")).toEqual({ verdict: "seal", protectedWork: false });
});
