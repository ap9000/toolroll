/**
 * Chat channels as a flow's inbox (v89), on Telegram: a group connected with
 * "/flow N" by a paired approver, its messages as cards (from anyone), a reply
 * joining the card's discussion. Slack, Discord and Teams are in their own
 * suites. The store and the bridge are real; Telegram is a scripted transport.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { flowFromSteps } from "./flows.js";
import { FLOW_WORDS } from "./chat-inbox.js";
import { addFlowTriggerTo } from "./flow-triggers.js";
import { bridgePass, hashPairingCode, mintPairingCode, PAIRING_TTL_MS, type TelegramTransport } from "./telegram.js";

const REPO = "/test/shop", BOT = "777000", GROUP = -1001234567;
const ALEX = { chat: 4242, user: 4242 };
const T0 = new Date("2026-09-25T09:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

let dir: string, store: Store;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-chat-inbox-")));
  store = openStore(join(dir, "orders.db"));
  if (!addApprover(store, "alex", T0).ok) throw new Error("bootstrap");
  const code = mintPairingCode();
  store.createTelegramPairing({ codeHash: hashPairingCode(code), approver: "alex", by: "alex", ttlMs: PAIRING_TTL_MS }, T0);
  expect(store.consumeTelegramPairing({ codeHash: hashPairingCode(code), botId: BOT, chatId: String(ALEX.chat), userId: String(ALEX.user), updateId: 1 }, T0).ok).toBe(true);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

test("the words that connect a channel, in every app's shape", () => {
  for (const words of ["flow 12", "Flow 12", "<@U0BOT> flow 12", "/flow 12", "/flow@StandingOrdersBot 12", "flow off", " flow  7 "]) expect(FLOW_WORDS.test(words.trim())).toBe(true);
  for (const words of ["flow", "flow twelve", "the flow 12", "flow 0", "flow 12 please"]) expect(FLOW_WORDS.test(words)).toBe(false);
});

test("a chat channel is never added from the canvas or chat: it says how to connect one from the channel", () => {
  const flow = store.createFlow({ repo: REPO, name: "Requests", by: "alex", definitionJson: JSON.stringify(flowFromSteps([{ title: "Inbox", kind: "inbox" }], null)) }, T0);
  expect(addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "chat" }, "alex", T0, dir)).toEqual({ ok: false, message: `kind: connect a chat channel from the channel itself: where Toolroll is in Slack, Discord, Teams or a Telegram group, send “flow ${flow}”` });
});

test("a Telegram group feeds a flow: /flow N from the paired approver connects it, anyone's message is a card, a reply joins it", async () => {
  const flow = store.createFlow({ repo: REPO, name: "Requests", by: "alex", definitionJson: JSON.stringify(flowFromSteps([{ title: "Inbox", kind: "inbox" }], null)) }, T0);
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const inbox: unknown[] = [];
  let update = 100, next = 500;
  const transport: TelegramTransport = async (method, params) => {
    calls.push({ method, params: params as Record<string, unknown> });
    if (method === "getUpdates") return { ok: true, result: inbox.splice(0) };
    if (method === "sendMessage") return { ok: true, result: { message_id: next++ } };
    return { ok: true, result: true };
  };
  const say = (from: { id: number; username?: string }, messageId: number, text: string, replyTo?: number) =>
    inbox.push({ update_id: update++, message: { message_id: messageId, date: 0, from, chat: { id: GROUP, type: "supergroup" }, text, ...(replyTo === undefined ? {} : { reply_to_message: { message_id: replyTo } }) } });
  const pass = (minutes: number) => bridgePass(store, { botId: BOT, transport, clock: () => at(minutes), readProjects: async () => [REPO] });
  const toGroup = () => calls.filter(call => call.method === "sendMessage" && call.params["chat_id"] === String(GROUP));
  // A stranger's words connect nothing; the paired approver's do.
  say({ id: 999, username: "stranger" }, 10, `/flow ${flow}`);
  say({ id: ALEX.user }, 11, `/flow@StandingOrdersBot ${flow}`);
  await pass(1);
  expect(toGroup().map(call => String(call.params["text"]))).toEqual([expect.stringContaining("This channel now feeds Requests")]);
  // Anyone's message is a card, answered in reply; a reply to it joins the card's discussion.
  say({ id: 999, username: "priya" }, 12, "Need a new laptop\nMine died.");
  await pass(2);
  const card = store.flowCards(flow, true)[0]!;
  expect(card).toMatchObject({ title: "Need a new laptop", description: "Need a new laptop\nMine died.", createdBy: "Telegram", source: { chat: { app: "telegram", chat: String(GROUP), thread: "12" } } });
  expect(toGroup().at(-1)!.params).toMatchObject({ text: "Added to Requests as a card. Replies here join its discussion.", reply_parameters: { message_id: 12 } });
  say({ id: 999, username: "priya" }, 13, "It's the Dell.", 12);
  await pass(3);
  expect(store.flowComments(card.id).map(one => [one.author, one.body])).toEqual([["@priya (Telegram)", "It's the Dell."]]);
  // "/flow off" stops it.
  say({ id: ALEX.user }, 14, "/flow off");
  say({ id: 999, username: "priya" }, 15, "Another one");
  await pass(4);
  expect(store.flowCards(flow, true)).toHaveLength(1);
  expect(toGroup().at(-1)!.params["text"]).toBe("This channel no longer feeds Requests.");
});
