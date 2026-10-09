/**
 * What a subagent remembers (v95): what its people told it and the facts it
 * keeps from its own turns are one memory, searched, edited and forgotten by
 * people, and each turn reads what its people said plus what fits the card.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store, type SubagentRow } from "./store.js";
import { addApprover } from "./scope.js";
import { run as exec } from "./exec.js";
import { runFlowSteps, type StepIo } from "./flow-steps.js";
import { editMemory, forgetMemory, MEMORY_CAP, memoriesFor, remember, searchMemories, tellSubagent } from "./subagent-memory.js";
import { SUBAGENT_TEMPLATES, type TurnRequest, type TurnRunner } from "./subagents.js";

const T0 = new Date("2026-09-26T09:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
let dir: string, repo: string, store: Store, flow: number, mate: SubagentRow;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-subagent-memory-")));
  repo = join(dir, "desk");
  store = openStore(join(dir, "orders.db"));
  if (!addApprover(store, "alex", T0).ok) throw new Error("bootstrap");
  const stage = (id: string, kind: string, rest: Record<string, unknown> = {}) => ({ id, title: id, kind, zone: {}, instructions: null, next: null, onFail: null, ...rest });
  flow = store.createFlow({ repo, name: "Support", by: "alex", definitionJson: JSON.stringify({ version: 1, start: "maya", stages: [
    stage("maya", "subagent", { subagent: "maya", routes: [{ answer: "Replied", to: "done" }] }), stage("done", "done"),
  ] }) }, T0);
  store.createSubagent({ repo, handle: "maya", soul: SUBAGENT_TEMPLATES[0]!.soul, model: null, manager: "alex", by: "alex" }, T0);
  mate = store.subagentByHandle(repo, "maya")!;
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const blank = { answer: "", text: "", note: "", question: "", options: [], reason: "", tool: "", input: "", remember: "" };
function turns(...answers: Record<string, unknown>[]): TurnRunner & { prompts: string[] } {
  const prompts: string[] = [];
  const runner = (async (request: TurnRequest) => {
    prompts.push(request.prompt);
    const next = answers.shift();
    if (next === undefined) throw new Error("no more turns scripted");
    return { ok: true as const, value: { ...blank, ...next }, ms: 10 };
  }) as TurnRunner & { prompts: string[] };
  runner.prompts = prompts;
  return runner;
}
const io = (subagent: TurnRunner): StepIo => ({ gh: exec, git: exec, shell: exec, fetch, dir, scratch: join(dir, "scratch"), base: "main", toolHome: dir, subagent });
const cardFor = (title: string, description: string | null = null) => store.addFlowCard({ flow, title, description, stage: "maya", by: "alex" }, T0);

test("a turn keeps a fact it learned, and a later card about the same thing reads it back beside what its people told it", async () => {
  expect(tellSubagent(store, mate, "This week, offer free shipping instead of a refund when you can.", "alex", T0)).toMatchObject({ ok: true });
  const first = cardFor("Where is my parcel?", "Please email me, don't call. — Sam Rivera");
  await runFlowSteps(store, repo, at(1), io(turns({ action: "route", answer: "Replied", text: "Hi Sam…", reason: "Answered.", remember: "Sam Rivera prefers email to phone calls." })));
  expect(store.getFlowCard(first)?.stage).toBe("done");
  expect(store.subagentMemories(mate.id).map(one => [one.source, one.text, one.card, one.createdBy])).toEqual([
    ["subagent", "Sam Rivera prefers email to phone calls.", first, "Maya (AI)"],
    ["person", "This week, offer free shipping instead of a refund when you can.", null, "alex"],
  ]);
  for (let at = 0; at < 10; at++) remember(store, mate, `Order batch ${at} shipped from the north warehouse.`, { source: "subagent", by: "Maya (AI)" }, T0);
  const second = cardFor("Refund for Sam Rivera", "Sam again: the lamp arrived broken.");
  const reads = turns({ action: "route", answer: "Replied", reason: "Answered." });
  await runFlowSteps(store, repo, at(2), io(reads));
  // What its people said, always; of what it kept, the fact about Sam first (it fits the card), then its newest.
  expect(reads.prompts[0]).toContain("WHAT YOUR PEOPLE TOLD YOU LATELY (follow it; newest last)\n- alex: This week, offer free shipping instead of a refund when you can.");
  expect(reads.prompts[0]).toContain("WHAT YOU REMEMBER FROM EARLIER CARDS (your own notes: check them against this card; the card wins)\n- Sam Rivera prefers email to phone calls.\n- Order batch 9 shipped");
  expect(reads.prompts[0].match(/Order batch \d shipped/g)).toHaveLength(7);
  expect(store.getFlowCard(second)?.stage).toBe("done");
});

test("people search, edit and forget what it remembers; the same words are kept once, secrets never, and its own facts are capped", () => {
  const kept = remember(store, mate, "Wholesale orders ship from the north warehouse.", { source: "subagent", by: "Maya (AI)" }, T0);
  expect(remember(store, mate, "wholesale orders ship from the north warehouse.", { source: "person", by: "alex" }, T0)).toMatchObject({ ok: true, said: "Maya already remembers that.", id: kept.id });
  expect(tellSubagent(store, mate, `The shop's GitHub token is ${["gh", "p_"].join("")}${"A1b2".repeat(9)}`, "alex", T0)).toMatchObject({ ok: false });
  expect(tellSubagent(store, mate, "x".repeat(301), "alex", T0)).toMatchObject({ ok: false });
  // Nearly the same words again from the same card refresh that line; from another card, a similar fact is its own line.
  const card = cardFor("Where's Priya's order?");
  const priya = remember(store, mate, "Priya Shah prefers store credit over refunds, and email over phone calls.", { source: "subagent", card, by: "Maya (AI)" }, T0);
  expect(remember(store, mate, "Priya Shah (order 2201) prefers store credit over refunds in future, and email contact over phone.", { source: "subagent", card, by: "Maya (AI)" }, at(1))).toMatchObject({ id: priya.id });
  expect(store.subagentMemory(priya.id!)?.text).toBe("Priya Shah (order 2201) prefers store credit over refunds in future, and email contact over phone.");
  const retail = remember(store, mate, "Retail orders ship from the north warehouse.", { source: "subagent", card: cardFor("Retail order"), by: "Maya (AI)" }, T0);
  expect(retail.id).not.toBe(kept.id);
  forgetMemory(store, mate, priya.id!, "alex", T0); forgetMemory(store, mate, retail.id!, "alex", T0);
  expect(searchMemories(store, mate, "north WHOLESALE").map(one => one.id)).toEqual([kept.id]);
  expect(searchMemories(store, mate, "south")).toEqual([]);
  expect(editMemory(store, mate, kept.id!, "Wholesale orders ship from the south warehouse.", "alex", at(1))).toMatchObject({ ok: true });
  expect(store.subagentMemory(kept.id!)).toMatchObject({ text: "Wholesale orders ship from the south warehouse.", updatedBy: "alex" });
  expect(forgetMemory(store, mate, kept.id!, "alex", at(2))).toMatchObject({ ok: true, said: "Maya forgot it." });
  expect(forgetMemory(store, mate, kept.id!, "alex", at(2))).toMatchObject({ ok: false });
  expect(memoriesFor(store, mate, "wholesale", at(3)).kept).toEqual([]);
  tellSubagent(store, mate, "Never promise a delivery date.", "alex", T0);
  for (let at = 0; at <= MEMORY_CAP; at++) remember(store, mate, `Fact number ${at}.`, { source: "subagent", by: "Maya (AI)" }, T0);
  expect(store.subagentMemories(mate.id, { source: "subagent" })).toHaveLength(MEMORY_CAP);
  expect(store.subagentMemories(mate.id, { source: "subagent" }).at(-1)?.text).toBe("Fact number 1.");
  expect(store.subagentMemories(mate.id, { source: "person" }).map(one => one.text)).toEqual(["Never promise a delivery date."]);
});
