/**
 * A teammate writes to known limits: its prompt states each one, an answer over one is asked once to shorten, and one
 * still over is kept whole (what the next zones read links to it), never cut.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { run as exec } from "./exec.js";
import { runFlowSteps, type StepIo } from "./flow-steps.js";
import { readTurn, TEAMMATE_TEMPLATES, TURN_LIMITS, turnOverruns, type TurnRequest, type TurnRunner } from "./teammates.js";

const T0 = new Date("2026-10-04T09:00:00.000Z");
let dir: string, repo: string, store: Store, flow: number;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-teammate-limits-")));
  repo = join(dir, "desk");
  store = openStore(join(dir, "orders.db"));
  if (!addApprover(store, "alex", T0).ok) throw new Error("bootstrap");
  const stage = (id: string, kind: string, rest: Record<string, unknown> = {}) => ({ id, title: id, kind, zone: {}, instructions: null, next: null, onFail: null, ...rest });
  flow = store.createFlow({ repo, name: "Support", by: "alex", definitionJson: JSON.stringify({ version: 1, start: "maya", stages: [
    stage("maya", "teammate", { title: "Maya replies", teammate: "maya", routes: [{ answer: "Replied", to: "done" }] }), stage("done", "done"),
  ] }) }, T0);
  store.createTeammate({ repo, handle: "maya", soul: TEAMMATE_TEMPLATES[0]!.soul, model: null, manager: "alex", by: "alex" }, T0);
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
const io = (teammate: TurnRunner): StepIo => ({ gh: exec, git: exec, shell: exec, fetch, dir, scratch: join(dir, "scratch"), base: "main", toolHome: dir, teammate });
const reply = "Hi Priya, your lamp shipped on the 15th and arrives tomorrow. ".repeat(250).trim();

test("an answer is read whole, never sliced, and its fields over their limits are named", () => {
  const read = readTurn({ ...blank, action: "route", answer: "Replied", text: reply, note: "n".repeat(TURN_LIMITS.note + 1) }, { kind: "handle", canSendBack: false, answers: ["Replied"] });
  if (!read.ok) throw new Error(read.issues.map(issue => issue.line).join("; "));
  const answer = read.value;
  expect(answer.text).toBe(reply);
  expect(turnOverruns(answer)).toEqual([{ field: "text", limit: 12_000, length: reply.length }, { field: "note", limit: 4_000, length: 4_001 }]);
});

test("the prompt states each limit; a reply over one is asked once to shorten, and the shortened reply goes on", async () => {
  const card = store.addFlowCard({ flow, title: "Where is my lamp?", description: null, stage: "maya", by: "alex" }, T0);
  const maya = turns({ action: "route", answer: "Replied", text: reply, reason: "Tracking shows it in transit." },
    { action: "route", answer: "Replied", text: "Hi Priya, your lamp arrives tomorrow.", reason: "Tracking shows it in transit." });
  await runFlowSteps(store, repo, T0, io(maya));
  expect(maya.prompts).toHaveLength(2);
  expect(maya.prompts[0]).toContain('Limits, in characters: "answer" 60, "text" 12,000, "note" 4,000');
  expect(maya.prompts[1]).toContain("YOUR LAST ANSWER, WHICH IS OVER A LIMIT");
  expect(maya.prompts[1]).toContain(`text is ${reply.length.toLocaleString("en-US")} characters; the limit is 12,000.`);
  expect(store.getFlowCard(card)).toMatchObject({ stage: "done", outputs: { maya: "Hi Priya, your lamp arrives tomorrow." } });
});

test("a reply still over its limit after the one ask is attached whole to the card, and the next zones read a link to it", async () => {
  const card = store.addFlowCard({ flow, title: "Where is my lamp?", description: null, stage: "maya", by: "alex" }, T0);
  const maya = turns({ action: "route", answer: "Replied", text: reply, reason: "In transit." }, { action: "route", answer: "Replied", text: reply, reason: "In transit." });
  await runFlowSteps(store, repo, T0, io(maya));
  expect(maya.prompts).toHaveLength(2);
  const moved = store.getFlowCard(card)!;
  expect(moved.stage).toBe("done");
  expect(moved.outputs["maya"]).toBe(`This is ${reply.length.toLocaleString("en-US")} characters, more than the 12,000 a step passes on, so it is kept whole on the card's discussion: /flows/${flow}?card=${card}.`);
  expect(store.flowComments(card).map(one => one.body)).toEqual([`What Maya · Support wrote for the next zones, in full (${reply.length.toLocaleString("en-US")} characters):\n\n${reply}`]);
  expect(moved.attached).toEqual({ maya: reply });
  expect(store.flowStepRun(card, 1)?.log).toContain(reply);
});

test("a send-back note still over 4,000 after the one ask is kept whole on the card, and the note links to it, never cut", async () => {
  const stage = (id: string, kind: string, rest: Record<string, unknown> = {}) => ({ id, title: id, kind, zone: {}, instructions: null, next: null, onFail: null, ...rest });
  const refunds = store.createFlow({ repo, name: "Refunds", by: "alex", definitionJson: JSON.stringify({ version: 1, start: "maya-decides", stages: [
    stage("maya-decides", "approval", { title: "Maya decides", teammate: "maya", toOwner: true, next: "done", onFail: "rework" }), stage("rework", "inbox"), stage("done", "done"),
  ] }) }, T0);
  const card = store.addFlowCard({ flow: refunds, title: "Refund $30 for order 51", description: null, stage: "maya-decides", by: "alex" }, T0);
  const note = "The order shows two lamps, but the refund covers one; check which was returned. ".repeat(60).trim();
  expect(note.length).toBeGreaterThan(4_000);
  const maya = turns({ action: "send_back", note, reason: "Amounts differ." }, { action: "send_back", note, reason: "Amounts differ." });
  await runFlowSteps(store, repo, T0, io(maya));
  expect(maya.prompts).toHaveLength(2);
  expect(maya.prompts[1]).toContain(`note is ${note.length.toLocaleString("en-US")} characters; the limit is 4,000.`);
  const back = store.getFlowCard(card)!;
  expect(back.stage).toBe("rework");
  expect(back.note).toBe(`This is ${note.length.toLocaleString("en-US")} characters, more than the 4,000 a note holds, so it is kept whole on the card's discussion: /flows/${refunds}?card=${card}.`);
  expect(store.flowComments(card).map(one => one.body)).toEqual([`Maya · Support's note, in full (${note.length.toLocaleString("en-US")} characters):\n\n${note}`]);
});
