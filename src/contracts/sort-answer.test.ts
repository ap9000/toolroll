import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSortDecision, readJevAnswers, sortRequest } from "../flow-sort.js";
import type { FlowStage } from "../flows.js";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import { SORT_ROUTE_KEY, sortKeyOf, sortNoteKeyOf } from "./flow.js";
import { jevReplySchema, readJevReply, readSortDecision, sortDecisionSchema } from "./sort-answer.js";

type Sample = { name: string; payload: unknown; paths?: string[] };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../test/fixtures/answers/${name}.json`, import.meta.url), "utf8")) as { valid: Sample[]; invalid: (Sample & { paths: string[] })[] };
const verdict = (parsed: { ok: true } | { ok: false; issues: { line: string }[] }): SampleVerdict => parsed.ok ? { ok: true } : { ok: false, lines: parsed.issues.map(issue => issue.line) };
const samples = (saved: ReturnType<typeof fixture>) => ({
  valid: saved.valid.map(one => ({ name: one.name, input: one.payload })),
  invalid: saved.invalid.map(one => ({ name: one.name, input: one.payload, paths: one.paths })),
});

const stage = {
  id: "sort", title: "Sort", kind: "sort", onFail: "by-hand",
  sort: {
    question: "What is this about?", sureAt: 0.8,
    answers: [{ answer: "Invoice problem", means: "billing", to: "billing" }, { answer: "Order change", means: "orders", to: "orders" }],
    notes: [{ id: "urgency", kind: "score", question: "How urgent is it?", levels: ["Later: no rush", "Soon: waiting", "Now: money is at stake"] }, { id: "refund", kind: "yes-no", question: "Money back?", levels: null }],
  },
} as unknown as FlowStage;

describe("Jev's sort answer contract", () => {
  it("holds for the reply: the JSON Schema round trip loses nothing, replies parse, and one lacking what routes is refused by path", () => {
    assertContract({ schema: jevReplySchema, read: input => verdict(readJevReply(input)), ...samples(fixture("jev-reply")) });
  });

  it("holds for the kept decision: saved decision_json rows parse as the schema says", () => {
    assertContract({ schema: sortDecisionSchema, read: input => verdict(readSortDecision(input)), ...samples(fixture("sort-decision")) });
  });

  it("asks with the flow contract's keys, and reads the reply back against the zone's own answers", () => {
    const request = sortRequest(stage.sort!, { title: "Charged twice" });
    expect(Object.keys(request.questions)).toEqual([SORT_ROUTE_KEY, sortNoteKeyOf("urgency"), sortNoteKeyOf("refund")]);
    expect(request.questions[SORT_ROUTE_KEY]).toMatchObject({ type: "choice", criteria: { [sortKeyOf("Invoice problem")]: "billing", [sortKeyOf("Order change")]: "orders" } });
    const reply = fixture("jev-reply").valid[0]!.payload as Record<string, unknown>;
    const decision = readJevAnswers(stage, reply, 9);
    expect(decision).toEqual({
      model: "typesafe/jev-1.13", answer: "Invoice problem", sure: 0.94, sureAt: 0.8, confident: true, to: "billing",
      chances: { "Invoice problem": 0.94, "Order change": 0.04 },
      notes: [{ id: "urgency", question: "How urgent is it?", kind: "score", answer: "Now: money is at stake", sure: 0.8 }, { id: "refund", question: "Money back?", kind: "yes-no", answer: "yes", sure: 0.9 }],
      cost: 0.000017, ms: 9,
    });
    // What a step keeps is the decision schema's shape, and the card reads it back as before.
    expect(readSortDecision(decision).ok).toBe(true);
    expect(parseSortDecision(JSON.stringify(decision))).toEqual(decision);
  });

  it("holds a card in the zone when Jev isn't sure, and never routes on a reply it can't read", () => {
    expect(readJevAnswers(stage, { answers: { route: { choice: "order-change", confidence: 0.5 } } }, 1)).toMatchObject({ answer: "Order change", confident: false, to: "by-hand", model: "~typesafe/jev-latest", cost: null, notes: [] });
    expect(readJevAnswers(stage, { answers: { route: { choice: "wire-money", confidence: 0.99 } } }, 1)).toEqual({ problem: "Jev picked an answer this zone doesn't have." });
    expect(readJevAnswers(stage, { answers: {} }, 1)).toEqual({ problem: "Jev's answer didn't say which way to go (answers.route: required)." });
  });
});
