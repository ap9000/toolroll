/**
 * A subagent's week (v97): each turn keeps what it cost; the week counts what
 * it did, what it cost and what its people overrode, and goes to its manager
 * on Monday mornings; and a person can undo a tool call with the action its
 * manager named — the same input, against a real MCP server.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store, type SubagentRow } from "./store.js";
import { addApprover } from "./scope.js";
import { run as exec, type ExecResult } from "./exec.js";
import { runFlowSteps, type StepIo } from "./flow-steps.js";
import { moveCardInFlow } from "./flow-engine.js";
import { addToolTo, validateToolSpec } from "./project-tools.js";
import { answerSubagentQuestion } from "./subagent-work.js";
import { grantTool, setToolRules } from "./subagent-tools.js";
import { requestUndo, runRequestedUndos, sendSubagentWeeklies, undoCall, undoFor, weekOf, weekWords } from "./subagent-week.js";
import { claudeTurnRunner, SUBAGENT_TEMPLATES, type TurnRequest, type TurnRunner } from "./subagents.js";

const T0 = new Date("2026-09-23T10:00:00.000Z"); // a Wednesday
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
let dir: string, repo: string, store: Store, flow: number, mate: SubagentRow, calls: string;

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-subagent-week-")));
  repo = join(dir, "shop");
  calls = join(dir, "calls.log");
  store = openStore(join(dir, "orders.db"));
  if (!addApprover(store, "alex", T0).ok) throw new Error("bootstrap");
  const server = join(dir, "desk-mcp.mjs");
  writeFileSync(server, `import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") reply(message.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "desk", version: "1" } });
  else if (message.method === "tools/list") reply(message.id, { tools: ["add_label", "remove_label"].map(name => ({ name, description: name, inputSchema: { type: "object", properties: { ticket: { type: "string" }, label: { type: "string" } }, required: ["ticket", "label"] } })) });
  else if (message.method === "tools/call") {
    appendFileSync(${JSON.stringify(calls)}, JSON.stringify(message.params) + "\\n");
    const fail = message.params.arguments.label === "stuck" && message.params.name === "remove_label";
    reply(message.id, { content: [{ type: "text", text: fail ? "Can't remove that label" : message.params.name + " " + message.params.arguments.label + " on " + message.params.arguments.ticket }], ...(fail ? { isError: true } : {}) });
  }
});
`);
  if (!addToolTo(store, repo, validateToolSpec({ name: "desk", command: process.execPath, args: [server], secrets: [], about: "The help desk" }), "test", "alex", T0, { home: dir }).ok) throw new Error("tool");
  const stage = (id: string, kind: string, rest: Record<string, unknown> = {}) => ({ id, title: id, kind, zone: {}, instructions: null, next: null, onFail: null, ...rest });
  flow = store.createFlow({ repo, name: "Support", by: "alex", definitionJson: JSON.stringify({ version: 1, start: "maya", stages: [
    stage("maya", "subagent", { subagent: "maya", routes: [{ answer: "Done", to: "done" }, { answer: "Urgent", to: "urgent" }] }), stage("urgent", "inbox"), stage("person", "inbox"), stage("done", "done"),
  ] }) }, T0);
  store.createSubagent({ repo, handle: "maya", soul: SUBAGENT_TEMPLATES[0]!.soul, model: null, manager: "alex", by: "alex" }, T0);
  mate = store.subagentByHandle(repo, "maya")!;
  expect(await grantTool(store, mate, "desk", "alex", T0, { toolHome: dir })).toMatchObject({ ok: true });
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const blank = { answer: "", text: "", note: "", question: "", options: [], reason: "", tool: "", input: "", remember: "" };
function turns(...answers: Record<string, unknown>[]): TurnRunner {
  return async (_request: TurnRequest) => {
    const next = answers.shift();
    if (next === undefined) throw new Error("no more turns scripted");
    return { ok: true as const, value: { ...blank, ...next }, ms: 30_000, costUsd: 0.0125, tokensIn: 6000, tokensOut: 300 };
  };
}
const io = (subagent: TurnRunner): StepIo => ({ gh: exec, git: exec, shell: exec, fetch, dir, scratch: join(dir, "scratch"), base: "main", toolHome: dir, subagent });
const made = () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line) as { name: string; arguments: Record<string, unknown> }) : [];
const cardFor = (title: string) => store.addFlowCard({ flow, title, description: null, stage: "maya", by: "alex" }, T0);

test("the CLI's cost and tokens are kept for each turn (cache reads count as input)", async () => {
  const cli = async (): Promise<ExecResult> => ({ code: 0, stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.0123,
    usage: { input_tokens: 1200, cache_creation_input_tokens: 300, cache_read_input_tokens: 5000, output_tokens: 210 }, structured_output: { action: "approve" } }), stderr: "", notFound: false, timedOut: false } as ExecResult);
  const reply = await claudeTurnRunner(cli)({ model: "default", prompt: "p", timeoutMs: 1000 });
  expect(reply).toMatchObject({ ok: true, costUsd: 0.0123, tokensIn: 6500, tokensOut: 210 });
});

test("the week counts what it did, what it cost and what people overrode, and reaches its manager once each Monday morning", async () => {
  setToolRules(store, mate, "desk", { add_label: { use: "ask" } }, "alex", T0);
  const first = cardFor("Printer on fire"), second = cardFor("Password reset");
  await runFlowSteps(store, repo, at(1), io(turns(
    { action: "use_tool", tool: "desk.add_label", input: '{"ticket": "T-1", "label": "urgent"}', reason: "It's on fire." },
    { action: "route", answer: "Done", text: "Reset link sent.", reason: "Routine." },
  )));
  const question = store.openSubagentQuestionOn(first, 1)!;
  answerSubagentQuestion(store, question.id, { choice: null, text: "Not urgent, it's a toy printer.", by: "alex", via: "web" }, at(2));
  await runFlowSteps(store, repo, at(3), io(turns({ action: "route", answer: "Urgent", reason: "Still a fire." })));
  // Alex moves it where it belongs, right after Maya moved it.
  moveCardInFlow(store, store.getFlowCard(first)!, "person", "alex", at(4));
  const week = weekOf(store, store.getSubagent(mate.id)!, at(5));
  expect(week).toMatchObject({ turns: 3, costUsd: 0.0375, minutes: 2, handled: 2, calls: { made: 0, approved: 0, denied: 1, refused: 0, undone: 0 } });
  expect(week.overrides.map(one => one.said)).toEqual([
    "alex moved “Printer on fire” after Maya did",
    "alex turned down desk → add_label · ticket T-1 · label urgent: “Not urgent, it's a toy printer.”",
  ]);
  expect(store.getFlowCard(second)?.stage).toBe("done");
  expect(weekWords(mate, week)).toBe([
    "Maya decided 0, handled 2, handed 0 to people and asked 0 questions.",
    "Tool calls: 0 made, 1 turned down.",
    "3 turns, about 2 minutes of thinking, $0.04 at API prices.",
    "You overrode it 2 times:",
    "• alex moved “Printer on fire” after Maya did",
    "• alex turned down desk → add_label · ticket T-1 · label urgent: “Not urgent, it's a toy printer.”",
  ].join("\n"));
  // Mid-week nothing goes out; Monday from 9:00 (this computer's time), once.
  const monday = new Date(2026, 8, 28, 9, 30);
  expect(sendSubagentWeeklies(store, repo, at(6))).toBe(0);
  expect(sendSubagentWeeklies(store, repo, monday)).toBe(1);
  expect(sendSubagentWeeklies(store, repo, new Date(monday.getTime() + 3600_000))).toBe(0);
  expect(store.handle.prepare("SELECT recipient, subject, link FROM notification WHERE kind = 'teammate-weekly'").all()).toEqual([{ recipient: "alex", subject: "Maya · Support: the week", link: `/settings/lead/subagents/${mate.id}#week` }]);
});

test("a person undoes a call with the action its manager named: the same input, as them; a failed undo leaves the call; the lead's undo is made by the worker", async () => {
  expect(setToolRules(store, mate, "desk", { add_label: { use: "free", undo: "add_label" } }, "alex", T0)).toMatchObject({ ok: false });
  expect(setToolRules(store, mate, "desk", { add_label: { use: "free", undo: "remove_label" }, remove_label: { use: "never" } }, "alex", T0)).toMatchObject({ ok: true });
  const card = cardFor("Label the printer ticket");
  await runFlowSteps(store, repo, at(1), io(turns(
    { action: "use_tool", tool: "desk.add_label", input: '{"ticket": "T-1", "label": "urgent"}', reason: "It's urgent." },
    { action: "use_tool", tool: "desk.add_label", input: '{"ticket": "T-2", "label": "stuck"}', reason: "Stuck." },
    { action: "route", answer: "Done", reason: "Labelled." },
  )));
  const [urgent, stuck] = store.subagentCallsOn(card);
  expect(undoFor(store, urgent!)).toBe("remove_label");
  const fresh = store.getSubagent(mate.id)!;
  // Undone as alex, even though Maya may never call remove_label herself.
  expect(await undoCall(store, fresh, urgent!.id, "alex", { toolHome: dir }, at(2))).toMatchObject({ ok: true, said: "Undone: desk → remove_label · ticket T-1 · label urgent. remove_label urgent on T-1" });
  expect(made().at(-1)).toEqual({ name: "remove_label", arguments: { ticket: "T-1", label: "urgent" } });
  expect(store.subagentCall(urgent!.id)).toMatchObject({ undoneBy: "alex" });
  expect(undoFor(store, store.subagentCall(urgent!.id)!)).toBeNull();
  expect(await undoCall(store, fresh, urgent!.id, "alex", { toolHome: dir }, at(3))).toMatchObject({ ok: false, said: "alex already undid it." });
  // The tool refuses: the call stands, and can be undone again later.
  expect(await undoCall(store, fresh, stuck!.id, "alex", { toolHome: dir }, at(4))).toMatchObject({ ok: false, said: "The undo call failed: Can't remove that label. The original call stands." });
  expect(store.subagentCall(stuck!.id)?.undoneBy).toBeNull();
  // Asked for in chat: recorded now, made by the worker's pass.
  const asked = requestUndo(store, fresh, stuck!.id, "alex", at(5));
  expect(asked).toMatchObject({ ok: true, said: "Undoing it with remove_label." });
  expect(await runRequestedUndos(store, { toolHome: dir }, at(6))).toBe(1);
  expect(store.subagentCallsOn(card).map(one => [one.action, one.state, one.undoOf, one.decidedBy])).toEqual([
    ["add_label", "done", null, null], ["add_label", "done", null, null], ["remove_label", "done", urgent!.id, "alex"], ["remove_label", "failed", stuck!.id, "alex"], ["remove_label", "failed", stuck!.id, "alex"],
  ]);
  expect(weekOf(store, fresh, at(7)).calls).toMatchObject({ made: 2, undone: 1 });
});
