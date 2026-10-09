/**
 * What a subagent may do (v92): decide only the zones it staffs, only
 * with the choices the zone offers, and a question it asks is answered only
 * by the person it asked. The card is data, and a model's answer is checked
 * before anything happens.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { decideFlowCard } from "./flow-engine.js";
import { answerSubagentQuestion } from "./subagent-work.js";
import { readTurn, SUBAGENT_TEMPLATES } from "./subagents.js";

const T0 = new Date("2026-09-26T10:00:00.000Z");
let dir: string, store: Store, flow: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-subagents-"));
  store = openStore(join(dir, "orders.db"));
  const stage = (id: string, kind: string, rest: Record<string, unknown> = {}) => ({ id, title: id, kind, zone: {}, next: null, onFail: null, ...rest });
  flow = store.createFlow({ repo: "/r", name: "Refunds", by: "alex", definitionJson: JSON.stringify({ version: 1, start: "maya-decides", stages: [
    stage("maya-decides", "approval", { subagent: "maya", toOwner: true, next: "refunded", onFail: "declined" }),
    stage("owner-decides", "approval", { toOwner: true, next: "refunded" }),
    stage("refunded", "inbox"), stage("declined", "inbox"),
  ] }) }, T0);
  store.createSubagent({ repo: "/r", handle: "maya", soul: SUBAGENT_TEMPLATES[0]!.soul, model: null, manager: "alex", by: "alex" }, T0);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

test("a subagent decides only a zone it staffs", () => {
  const theirs = store.addFlowCard({ flow, title: "Refund $30 for order 51", description: null, stage: "maya-decides", by: "alex" }, T0);
  const ours = store.addFlowCard({ flow, title: "Refund $400 for order 52", description: null, stage: "owner-decides", by: "alex" }, T0);
  expect(decideFlowCard(store, { card: ours, decision: "approve", note: null, actor: "Maya (AI)", repos: ["/r"], subagent: "maya" }, T0)).toMatchObject({ ok: false });
  expect(decideFlowCard(store, { card: theirs, decision: "approve", note: null, actor: "Leo (AI)", repos: ["/r"], subagent: "leo" }, T0)).toMatchObject({ ok: false });
  expect(decideFlowCard(store, { card: theirs, decision: "approve", note: "Within my $50 limit.", actor: "Maya (AI)", repos: ["/r"], subagent: "maya" }, T0)).toMatchObject({ ok: true });
  expect(store.getFlowCard(theirs)?.stage).toBe("refunded");
  expect(store.getFlowCard(ours)?.stage).toBe("owner-decides");
});

test("a turn must be one of the zone's own choices, and a refusal names its path", () => {
  const decide = { kind: "decide" as const, canSendBack: false, answers: [] };
  const base = { answer: "", text: "", note: "", question: "", options: [], reason: "", tool: "", input: "", remember: "" };
  const lines = (value: unknown, context: Parameters<typeof readTurn>[1]) => { const read = readTurn(value, context); return read.ok ? [] : read.issues.map(issue => issue.line); };
  expect(readTurn({ ...base, action: "approve" }, decide).ok).toBe(true);
  // No send-back path here, and a work zone's actions don't apply to a decision.
  expect(lines({ ...base, action: "send_back", note: "no" }, decide)).toEqual(['action: "send_back" isn\'t one this zone allows ("approve", "hand_off")']);
  expect(lines({ ...base, action: "route", answer: "Refund" }, decide)).toHaveLength(1);
  const handle = { kind: "handle" as const, canSendBack: false, answers: ["Reply", "Refund request"] };
  expect(readTurn({ ...base, action: "route", answer: "refund request" }, handle).ok).toBe(true);
  expect(lines({ ...base, action: "route", answer: "Wire the money" }, handle)).toEqual(['answer: "Wire the money" isn\'t one of this zone\'s answers']);
  expect(lines({ ...base, action: "approve" }, handle)).toHaveLength(1);
  expect(lines({ ...base, action: "ask" }, handle)).toEqual(["question: required for ask"]);
  expect(lines("approve it", handle)).toEqual(["payload: must be an object (got a string)"]);
  // Plain-text and older replies keep the original defaults and ignore unknown keys.
  expect(readTurn({ action: "approve" }, decide)).toEqual({ ok: true, value: { ...base, action: "approve" } });
  expect(readTurn({ action: "route", answer: " Reply ", remember: undefined, options: "Yes", mood: "calm" }, handle))
    .toEqual({ ok: true, value: { ...base, action: "route", answer: "Reply" } });
  expect(readTurn({ action: "ask", question: " Which? ", options: [null, "", 7, " Yes ", "No", "Later", "Never", "Another"] }, handle))
    .toEqual({ ok: true, value: { ...base, action: "ask", question: "Which?", options: ["Yes", "No", "Later", "Never"] } });
});

test("only the person asked answers a subagent's question, once", () => {
  const card = store.addFlowCard({ flow, title: "Refund $200 for order 54", description: null, stage: "refunded", by: "alex" }, T0);
  const mate = store.subagentByHandle("/r", "maya")!;
  const id = store.openSubagentQuestion({ subagent: mate.id, card, entry: 1, question: "Refund all $200?", options: [{ id: "o1", label: "Yes" }, { id: "o2", label: "Half" }], askedOf: "alex" }, T0)!;
  expect(answerSubagentQuestion(store, id, { choice: "o1", text: null, by: "sam", via: "web" }, T0)).toMatchObject({ ok: false });
  expect(answerSubagentQuestion(store, id, { choice: "o9", text: null, by: "alex", via: "web" }, T0)).toMatchObject({ ok: false });
  expect(answerSubagentQuestion(store, id, { choice: "o2", text: null, by: "alex", via: "web" }, T0)).toMatchObject({ ok: true });
  expect(answerSubagentQuestion(store, id, { choice: "o1", text: null, by: "alex", via: "web" }, T0)).toMatchObject({ ok: false });
  expect(store.subagentQuestion(id)).toMatchObject({ state: "answered", choice: "o2", answeredBy: "alex" });
});
