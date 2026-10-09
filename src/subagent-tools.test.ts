/**
 * Subagents that act (v94): a subagent uses the project tools its manager let
 * it use, within a rule per action — do it, ask first, never, or do it up to
 * a limit. A real MCP server over stdio answers; only the model's turns are
 * scripted. Every call is a receipt, an ask-first call waits for its person,
 * and Approve makes exactly the call they saw.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store, type SubagentRow } from "./store.js";
import { addApprover } from "./scope.js";
import { run as exec } from "./exec.js";
import { runFlowSteps, type StepIo } from "./flow-steps.js";
import { addToolTo, validateToolSpec } from "./project-tools.js";
import { answerSubagentQuestion } from "./subagent-work.js";
import { grantTool, ruleFor, setToolRules } from "./subagent-tools.js";
import { SUBAGENT_TEMPLATES, type TurnRequest, type TurnRunner } from "./subagents.js";

const T0 = new Date("2026-09-26T09:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
let dir: string, repo: string, store: Store, flow: number, mate: SubagentRow, calls: string;

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-subagent-tools-")));
  repo = join(dir, "shop");
  calls = join(dir, "calls.log");
  store = openStore(join(dir, "orders.db"));
  if (!addApprover(store, "alex", T0).ok) throw new Error("bootstrap");
  const server = join(dir, "shop-mcp.mjs");
  writeFileSync(server, `import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") reply(message.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "shop", version: "1" } });
  else if (message.method === "tools/list") reply(message.id, { tools: [
    { name: "lookup_order", description: "Look an order up", inputSchema: { type: "object", properties: { order: { type: "string" } }, required: ["order"] }, annotations: { readOnlyHint: true } },
    { name: "refund_order", description: "Refund an order", inputSchema: { type: "object", properties: { order: { type: "string" }, amount: { type: "number" } }, required: ["order", "amount"] } },
    { name: "delete_customer", description: "Delete a customer", inputSchema: { type: "object", properties: { email: { type: "string" } }, required: ["email"] } },
  ] });
  else if (message.method === "tools/call") {
    appendFileSync(${JSON.stringify(calls)}, JSON.stringify(message.params) + "\\n");
    const args = message.params.arguments;
    reply(message.id, { content: [{ type: "text", text: message.params.name === "lookup_order" ? "Order " + args.order + ": delivered, $30, paid by card with key " + process.env.SHOP_KEY : "Refunded $" + args.amount + " on order " + args.order }] });
  }
});
`);
  const key = ["sk", "live", "shopfixture", "0123456789abcdef"].join("_");
  if (!addToolTo(store, repo, validateToolSpec({ name: "shop", command: process.execPath, args: [server], secrets: [{ name: "SHOP_KEY", optional: false }], about: "The shop" }), "test", "alex", T0, { values: { SHOP_KEY: key }, home: dir }).ok) throw new Error("tool");
  const stage = (id: string, kind: string, rest: Record<string, unknown> = {}) => ({ id, title: id, kind, zone: {}, instructions: null, next: null, onFail: null, ...rest });
  flow = store.createFlow({ repo, name: "Support", by: "alex", definitionJson: JSON.stringify({ version: 1, start: "maya", stages: [
    stage("maya", "subagent", { subagent: "maya", instructions: "Handle refund requests.", routes: [{ answer: "Refunded", to: "done" }, { answer: "Needs a person", to: "inbox" }] }),
    stage("inbox", "inbox"), stage("done", "done"),
  ] }) }, T0);
  store.createSubagent({ repo, handle: "maya", soul: SUBAGENT_TEMPLATES[0]!.soul, model: null, manager: "alex", by: "alex" }, T0);
  mate = store.subagentByHandle(repo, "maya")!;
  expect(await grantTool(store, mate, "shop", "alex", T0, { toolHome: dir })).toMatchObject({ ok: true });
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const blank = { answer: "", text: "", note: "", question: "", options: [], reason: "", tool: "", input: "", remember: "" };
/** Scripted turns: each gets the prompt it was sent; tests read them afterwards. */
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
const made = () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line) as { name: string; arguments: Record<string, unknown> }) : [];
const cardFor = (title: string) => store.addFlowCard({ flow, title, description: "From priya@example.com", stage: "maya", by: "alex" }, T0);

test("reading is free and the rest asks first, until its manager says otherwise; a limit holds in code", () => {
  const grant = store.subagentGrant(mate.id, "shop")!;
  expect(grant.rules).toEqual({ lookup_order: { use: "free" }, refund_order: { use: "ask" }, delete_customer: { use: "ask" } });
  expect(setToolRules(store, mate, "shop", { refund_order: { use: "free", limit: { field: "order", over: 50 } } }, "alex", T0)).toMatchObject({ ok: false, said: "refund_order has no number called order." });
  expect(setToolRules(store, mate, "shop", { refund_order: { use: "free", limit: { field: "amount", over: -1 } } }, "alex", T0)).toMatchObject({ ok: false });
  expect(setToolRules(store, mate, "shop", { wire_money: { use: "free" } }, "alex", T0)).toMatchObject({ ok: false, said: "shop has no action called wire_money. Its actions: lookup_order, refund_order, delete_customer." });
  expect(setToolRules(store, mate, "shop", { refund_order: { use: "free", limit: { field: "amount", over: 50 } }, delete_customer: { use: "never" } }, "alex", T0)).toMatchObject({ ok: true });
  const rules = store.subagentGrant(mate.id, "shop")!;
  expect(ruleFor(rules, "refund_order", { order: "1", amount: 30 }).use).toBe("free");
  expect(ruleFor(rules, "refund_order", { order: "1", amount: "$50" }).use).toBe("free");
  expect(ruleFor(rules, "refund_order", { order: "1", amount: 50.01 })).toEqual({ use: "ask", why: "amount 50.01 is over the limit of 50." });
  expect(ruleFor(rules, "refund_order", { order: "1" }).use).toBe("ask");
  expect(ruleFor(rules, "delete_customer", { email: "a@b.c" }).use).toBe("never");
  expect(ruleFor(rules, "wire_money", {}).use).toBe("never");
});

test("a subagent looks an order up and refunds it within its limit, reads both answers, then decides; secrets never reach it", async () => {
  setToolRules(store, mate, "shop", { refund_order: { use: "free", limit: { field: "amount", over: 50 } }, delete_customer: { use: "never" } }, "alex", T0);
  const card = cardFor("Refund my $30 order 1043, it arrived broken");
  const maya = turns(
    { action: "use_tool", tool: "shop.lookup_order", input: '{"order": "1043"}', reason: "Check the order." },
    { action: "use_tool", tool: "shop.refund_order", input: '{"order": "1043", "amount": 30}', reason: "Within my $50 limit." },
    { action: "route", answer: "Refunded", text: "Hi Priya, we've refunded $30.", reason: "Refunded within my limit." },
  );
  await runFlowSteps(store, repo, at(1), io(maya));
  expect(made()).toEqual([{ name: "lookup_order", arguments: { order: "1043" } }, { name: "refund_order", arguments: { order: "1043", amount: 30 } }]);
  expect(store.getFlowCard(card)).toMatchObject({ stage: "done", outputs: { maya: "Hi Priya, we've refunded $30." } });
  expect(store.subagentCallsOn(card).map(one => [one.action, one.rule, one.state])).toEqual([["lookup_order", "free", "done"], ["refund_order", "free", "done"]]);
  // It is offered its actions with their rules, never the one it may never use, and reads what the tool said — without the key.
  expect(maya.prompts[0]).toContain("- shop.lookup_order (use freely): Look an order up");
  expect(maya.prompts[0]).toContain("- shop.refund_order (use freely up to amount 50; above that, a person approves first)");
  expect(maya.prompts[0]).not.toContain("delete_customer");
  expect(maya.prompts[2]).toContain('2. shop.refund_order {"order":"1043","amount":30} → done:\nRefunded $30 on order 1043');
  expect(maya.prompts[2]).toContain("Order 1043: delivered, $30, paid by card with key [secret]");
  expect(maya.prompts.join("\n")).not.toContain("shopfixture");
});

test("a call over its limit waits for its person; Approve makes exactly that call, and Deny with words doesn't", async () => {
  setToolRules(store, mate, "shop", { refund_order: { use: "free", limit: { field: "amount", over: 50 } } }, "alex", T0);
  const card = cardFor("Refund my $400 order 1044");
  const maya = turns({ action: "use_tool", tool: "shop.refund_order", input: '{"order": "1044", "amount": 400}', reason: "Damaged on arrival." });
  await runFlowSteps(store, repo, at(1), io(maya));
  const [call] = store.subagentCallsOn(card);
  expect(call).toMatchObject({ state: "asked", rule: "ask", result: "amount 400 is over the limit of 50." });
  expect(made()).toEqual([]);
  const question = store.subagentQuestionForCall(call!.id)!;
  expect(question).toMatchObject({ state: "open", question: "Use shop → refund_order · order 1044 · amount 400?", askedOf: "alex", options: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }] });
  expect(store.handle.prepare("SELECT subject FROM notification WHERE dedupe_key LIKE ?").get(`%teammate-q:${question.id}:%`)?.subject).toBe("Support: Maya · Support asks to use refund_order on “Refund my $400 order 1044”");
  expect(store.getFlowCard(card)?.waiting).toBe("Maya asked alex to approve: shop → refund_order · order 1044 · amount 400");
  // Nothing more happens while it waits.
  await runFlowSteps(store, repo, at(2), io(maya));
  expect(maya.prompts).toHaveLength(1);
  expect(answerSubagentQuestion(store, question.id, { choice: "approve", text: null, by: "sam", via: "web" }, at(3))).toMatchObject({ ok: false });
  expect(answerSubagentQuestion(store, question.id, { choice: "approve", text: null, by: "alex", via: "telegram" }, at(3))).toMatchObject({ ok: true, said: "Approved. The call is made now, exactly as shown." });
  expect(answerSubagentQuestion(store, question.id, { choice: "deny", text: null, by: "alex", via: "web" }, at(3))).toMatchObject({ ok: false });
  const after = turns({ action: "route", answer: "Refunded", text: "Refunded $400.", reason: "alex approved it." });
  await runFlowSteps(store, repo, at(4), io(after));
  expect(made()).toEqual([{ name: "refund_order", arguments: { order: "1044", amount: 400 } }]);
  expect(store.subagentCall(call!.id)).toMatchObject({ state: "done", decidedBy: "alex", result: "Refunded $400 on order 1044" });
  expect(after.prompts[0]).toContain('1. shop.refund_order {"order":"1044","amount":400} → alex approved it; done:\nRefunded $400 on order 1044');
  expect(store.getFlowCard(card)?.stage).toBe("done");

  const other = cardFor("Refund my $300 order 1045");
  await runFlowSteps(store, repo, at(5), io(turns({ action: "use_tool", tool: "shop.refund_order", input: '{"order": "1045", "amount": 300}', reason: "Late." })));
  const denied = store.openSubagentQuestionOn(other, 1)!;
  expect(answerSubagentQuestion(store, denied.id, { choice: null, text: "Offer a $50 credit instead.", by: "alex", via: "slack" }, at(6))).toMatchObject({ ok: true, said: "It won't make that call. It picks the card up again now." });
  const again = turns({ action: "route", answer: "Needs a person", text: "Offer a $50 credit.", reason: "alex said to offer a credit." });
  await runFlowSteps(store, repo, at(7), io(again));
  expect(again.prompts[0]).toContain('1. shop.refund_order {"order":"1045","amount":300} → alex denied it:\nOffer a $50 credit instead.');
  expect(made()).toHaveLength(1);
  expect(store.getFlowCard(other)?.stage).toBe("inbox");
});

test("a call outside its rules is refused and read back; a card that moved on is never acted on; tools run out", async () => {
  setToolRules(store, mate, "shop", { delete_customer: { use: "never" } }, "alex", T0);
  const card = cardFor("Delete my account");
  const maya = turns(
    { action: "use_tool", tool: "shop.delete_customer", input: '{"email": "priya@example.com"}', reason: "They asked." },
    { action: "use_tool", tool: "shop.lookup_order", input: "{}", reason: "Check." },
    { action: "use_tool", tool: "shop.lookup_order", input: "not json", reason: "Check." },
    { action: "route", answer: "Needs a person", text: "", reason: "I can't delete accounts." },
  );
  await runFlowSteps(store, repo, at(1), io(maya));
  expect(made()).toEqual([]);
  expect(store.subagentCallsOn(card).map(one => [one.action, one.state, one.result])).toEqual([
    ["delete_customer", "refused", "There's no shop.delete_customer among the tools you may use."],
    ["lookup_order", "refused", "It needs order."],
    ["lookup_order", "refused", "Its input wasn't a JSON object."],
  ]);
  expect(maya.prompts[3]).toContain("3. shop.lookup_order {} → not made:\nIts input wasn't a JSON object.");
  expect(store.getFlowCard(card)?.stage).toBe("inbox");

  // Approved after the card moved on: nothing is done.
  const moved = cardFor("Refund my $80 order 1046");
  await runFlowSteps(store, repo, at(2), io(turns({ action: "use_tool", tool: "shop.refund_order", input: '{"order": "1046", "amount": 80}', reason: "Late." })));
  const question = store.openSubagentQuestionOn(moved, 1)!;
  store.moveFlowCard(moved, { to: "inbox", outcome: "ok", actor: "alex" }, at(3));
  expect(answerSubagentQuestion(store, question.id, { choice: "approve", text: null, by: "alex", via: "web" }, at(4))).toMatchObject({ ok: false, said: "That card has moved on, so nothing was done." });
  expect(store.subagentCallsOn(moved)[0]).toMatchObject({ state: "refused", result: "The card moved on before anyone approved it." });
  expect(made()).toEqual([]);

  // A turn that only ever reaches for tools is told to decide once a visit's calls run out.
  const busy = cardFor("Where is order 1047?");
  const lookups = Array.from({ length: 8 }, () => ({ action: "use_tool", tool: "shop.lookup_order", input: '{"order": "1047"}', reason: "Check again." }));
  const eager = turns(...lookups, { action: "route", answer: "Needs a person", text: "", reason: "Out of lookups." });
  await runFlowSteps(store, repo, at(5), io(eager));
  expect(eager.prompts).toHaveLength(9);
  expect(eager.prompts[8]).not.toContain("YOUR TOOLS");
  expect(eager.prompts[8]).toContain("You've used your tools as much as one visit allows.");
  expect(store.getFlowCard(busy)?.stage).toBe("inbox");
});

test("an approved call is made only if its rules still allow it when it's made", async () => {
  const card = cardFor("Refund my $90 order 1048");
  await runFlowSteps(store, repo, at(1), io(turns({ action: "use_tool", tool: "shop.refund_order", input: '{"order": "1048", "amount": 90}', reason: "Late." })));
  const question = store.openSubagentQuestionOn(card, 1)!;
  expect(answerSubagentQuestion(store, question.id, { choice: "approve", text: null, by: "alex", via: "web" }, at(2))).toMatchObject({ ok: true });
  setToolRules(store, mate, "shop", { refund_order: { use: "never" } }, "alex", at(3));
  const after = turns({ action: "route", answer: "Needs a person", text: "", reason: "The refund wasn't made." });
  await runFlowSteps(store, repo, at(4), io(after));
  expect(made()).toEqual([]);
  expect(store.subagentCallsOn(card)[0]).toMatchObject({ state: "refused", result: "Its rules changed before the call was made." });
  expect(after.prompts[0]).toContain("→ not made:\nIts rules changed before the call was made.");
});

test("approving the same call five times in a row, none denied, makes it suggest the rule that fits; its manager's answer is the only one that counts", () => {
  setToolRules(store, mate, "shop", { refund_order: { use: "free", limit: { field: "amount", over: 50 } } }, "alex", T0);
  let minute = 0;
  const decide = (amount: number, choice: "approve" | "deny" | null = "approve", text: string | null = null) => {
    minute++;
    const card = cardFor(`Refund my $${amount} order ${minute}`);
    const call = store.addSubagentCall({ subagent: mate.id, card, entry: 1, tool: "shop", action: "refund_order", input: { order: String(minute), amount }, rule: "ask", why: "Over my limit.", state: "asked" }, at(minute));
    const question = store.openSubagentQuestion({ subagent: mate.id, card, entry: 1, question: "Use it?", options: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }], askedOf: "alex", toolCall: call }, at(minute))!;
    expect(answerSubagentQuestion(store, question, { choice, text, by: "alex", via: "telegram" }, at(minute))).toMatchObject({ ok: true });
    return card;
  };
  const open = () => store.subagentSuggestions(mate.id).filter(one => one.state === "open");
  for (const amount of [55, 60]) decide(amount);
  decide(90, "deny");
  for (const amount of [58, 62, 66, 70]) decide(amount);
  expect(open()).toEqual([]);
  const last = decide(72);
  const [suggested] = open();
  expect(suggested).toMatchObject({ tool: "shop", action: "refund_order", rule: { use: "free", limit: { field: "amount", over: 75 } }, was: { use: "free", limit: { field: "amount", over: 50 } },
    said: "You approved my last 5 refund_order calls on shop (amount 58 to 72). May I make them on my own up to amount 75, and ask you above that?" });
  const question = store.subagentQuestionForSuggestion(suggested!.id)!;
  expect(question).toMatchObject({ askedOf: "alex", card: last, options: [{ id: "accept", label: "Yes, change it" }, { id: "dismiss", label: "Not now" }] });
  expect(store.handle.prepare("SELECT subject FROM notification WHERE dedupe_key LIKE ?").get(`%teammate-q:${question.id}:%`)?.subject).toBe("Support: Maya · Support suggests a rule change");
  // It never holds up a card.
  expect(store.openSubagentQuestionOn(last, 1)).toBeNull();
  expect(answerSubagentQuestion(store, question.id, { choice: "accept", text: null, by: "sam", via: "web" }, at(20))).toMatchObject({ ok: false });
  expect(answerSubagentQuestion(store, question.id, { choice: "accept", text: null, by: "alex", via: "slack" }, at(20))).toMatchObject({ ok: true, said: "Changed. Maya makes refund_order calls on its own up to amount 75." });
  expect(store.subagentGrant(mate.id, "shop")?.rules["refund_order"]).toEqual({ use: "free", limit: { field: "amount", over: 75 } });
  // Five more over the new limit: it suggests again; "not now" in words is remembered.
  minute = 30;
  for (const amount of [80, 85, 90, 95]) decide(amount);
  decide(120);
  const again = open()[0]!;
  expect(again.rule).toEqual({ use: "free", limit: { field: "amount", over: 125 } });
  expect(answerSubagentQuestion(store, store.subagentQuestionForSuggestion(again.id)!.id, { choice: null, text: "Keep it at 75 until October.", by: "alex", via: "web" }, at(50))).toMatchObject({ ok: true, said: "Left as it is." });
  expect(store.subagentSuggestion(again.id)?.state).toBe("dismissed");
  expect(store.subagentMemories(mate.id, { source: "person" }).map(one => one.text)).toEqual(["About refund_order on shop: Keep it at 75 until October."]);
  // A suggestion made before its rule changed can't be accepted.
  minute = 60;
  for (const amount of [80, 81, 82, 83, 84]) decide(amount);
  const stale = open()[0]!;
  setToolRules(store, mate, "shop", { refund_order: { use: "ask" } }, "alex", at(70));
  expect(answerSubagentQuestion(store, store.subagentQuestionForSuggestion(stale.id)!.id, { choice: "accept", text: null, by: "alex", via: "web" }, at(71))).toMatchObject({ ok: false, said: "Its rules changed since it suggested this, so nothing was changed." });
  expect(store.subagentSuggestion(stale.id)?.state).toBe("stale");
  expect(store.subagentGrant(mate.id, "shop")?.rules["refund_order"]).toEqual({ use: "ask" });
});
