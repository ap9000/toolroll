/**
 * Who a card takes a reply from (v91): only someone its email went to. A
 * Message-ID is no secret — anyone the thread reaches can copy it into a
 * header — so a stranger naming it never moves the card, and neither does a
 * machine's automatic answer.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { recordSent, takeReply } from "./flow-replies.js";
import type { InboundMail } from "./mailbox.js";

const T0 = new Date("2026-09-25T10:00:00.000Z");
let dir: string, store: Store, card: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-replies-"));
  store = openStore(join(dir, "orders.db"));
  const stage = (id: string, kind: string, rest: Record<string, unknown> = {}) => ({ id, title: id, kind, zone: {}, next: null, onFail: null, ...rest });
  const flow = store.createFlow({ repo: "/r", name: "Follow-ups", by: "alex", definitionJson: JSON.stringify({ version: 1, start: "wait", stages: [
    stage("wait", "wait", { wait: { for: "reply", minutes: 60 }, next: "answered", onFail: "silent" }), stage("answered", "inbox"), stage("silent", "inbox"),
  ] }) }, T0);
  card = store.addFlowCard({ flow, title: "Refund for order 42?", description: null, stage: "wait", by: "alex", byKind: "person" }, T0);
  recordSent(store, store.getFlowCard(card)!, { id: "<sent-1@shop.example>", to: ["Priya@Example.com"] }, T0);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const mail = (from: string, rest: Partial<InboundMail> = {}): InboundMail => ({ uid: 1, messageId: `<r-${from}@mail.example>`, inReplyTo: "<sent-1@shop.example>", references: ["<sent-1@shop.example>"],
  from, fromName: null, subject: "Re: Refund", text: "Yes please, refund it.", automatic: false, ...rest });

test("a stranger naming the card's email, or an automatic answer, is not a reply", () => {
  expect(takeReply(store, mail("mallory@evil.example"), "support@shop.example", T0)).toBeNull();
  expect(takeReply(store, mail("priya@example.com", { automatic: true }), "support@shop.example", T0)).toBeNull();
  expect(store.getFlowCard(card)).toMatchObject({ stage: "wait", entry: 1 });
  expect(store.flowComments(card)).toEqual([]);
});

test("the person it went to replies: the card moves on with the reply, once", () => {
  const taken = takeReply(store, mail("priya@example.com"), "support@shop.example", T0);
  expect(taken).toMatchObject({ moved: true, again: false });
  expect(store.getFlowCard(card)).toMatchObject({ stage: "answered", outputs: { wait: "From: priya@example.com\n\nYes please, refund it." } });
  expect(store.flowComments(card).map(one => one.author)).toEqual(["priya@example.com"]);
  // Read again (by an Inbox trigger, say): the same reply is not taken twice.
  expect(takeReply(store, mail("priya@example.com"), "support@shop.example", T0)).toMatchObject({ again: true, moved: false });
  expect(store.flowComments(card)).toHaveLength(1);
});
