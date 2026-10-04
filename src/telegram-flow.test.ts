/**
 * A send-back note or an edited draft typed in Telegram is taken whole up to its limit, and one over it is refused
 * with the limit, never cut.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store, type TelegramBinding, type TelegramFlowPrompt } from "./store.js";
import { flowFromSteps } from "./flows.js";
import { applyFlowReply } from "./telegram-flow.js";
import { decideFlowCard } from "./flow-engine.js";

const T0 = new Date("2026-10-04T09:00:00.000Z");
const repo = "/r";
let dir: string, store: Store, flow: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-telegram-flow-"));
  store = openStore(join(dir, "orders.db"));
  flow = store.createFlow({ repo, name: "Support", by: "alex", definitionJson: JSON.stringify(flowFromSteps([
    { title: "Inbox", kind: "inbox" },
    { id: "draft", title: "Write the reply", kind: "draft", instructions: "Reply to {{card.title}}" },
    { id: "check", title: "Check the reply", kind: "approval", decider: "owner", ifFails: "Write the reply" },
    { id: "post", title: "Post it", kind: "notify", message: "{{stage.draft}}" },
  ], null)) }, T0);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const binding = { id: 1, approver: "alex" } as TelegramBinding;
const waiting = () => {
  const card = store.addFlowCard({ flow, title: "Refund for order 42?", description: null, stage: "check", by: "alex" }, T0);
  store.updateFlowCard(card, { outputs: { draft: "We refunded it." } }, T0);
  return card;
};
const prompt = (card: number, mode: TelegramFlowPrompt["mode"]): TelegramFlowPrompt => ({ chatId: "1", messageId: "1", binding: 1, card, entry: 1, mode });

test("a send-back note over 4,000 characters is refused with its limit; one at the limit goes back whole", () => {
  const card = waiting();
  const over = "Mention the 5-day wait and the tracking link. ".repeat(90).slice(0, 4_001);
  expect(applyFlowReply(store, binding, prompt(card, "send-back"), over, [repo], T0)).toEqual([{ kind: "say", text: "That's 4,001 characters. Keep the note to 4,000, or send it back in Toolroll." }]);
  expect(store.getFlowCard(card)).toMatchObject({ stage: "check", note: null });
  const whole = over.slice(0, 4_000).trim();
  expect(applyFlowReply(store, binding, prompt(card, "send-back"), whole, [repo], T0)).toEqual([{ kind: "say", text: "↩️ Sent back to Write the reply with your note." }]);
  expect(store.getFlowCard(card)).toMatchObject({ stage: "draft", note: whole });
});

test("an edited draft over its limit is refused with the limit, never cut", () => {
  const card = waiting();
  expect(applyFlowReply(store, binding, prompt(card, "edit"), "d".repeat(4_001), [repo], T0)).toEqual([{ kind: "say", text: "That's 4,001 characters. Keep it to 4,000, or change it in Toolroll." }]);
  expect(store.getFlowCard(card)!.outputs["draft"]).toBe("We refunded it.");
});

test("the decision door refuses a person's edited draft over 12,000 characters with the limit; one at it is kept whole", () => {
  const card = waiting();
  expect(decideFlowCard(store, { card, decision: "approve", note: null, actor: "alex", repos: [repo], draft: "d".repeat(12_001) }, T0)).toEqual({ ok: false, message: "Keep the draft to 12,000 characters; this is 12,001." });
  expect(store.getFlowCard(card)).toMatchObject({ stage: "check", outputs: { draft: "We refunded it." } });
  expect(decideFlowCard(store, { card, decision: "approve", note: null, actor: "alex", repos: [repo], draft: "d".repeat(12_000) }, T0)).toMatchObject({ ok: true });
  expect(store.getFlowCard(card)!.outputs["draft"]).toBe("d".repeat(12_000));
});
