/**
 * A flow never cuts a card's details to file its work: they go into the goal whole up to the task goal limit, a value
 * too long for it (a script's output) is attached instead and the agent is given it whole, instructions take the full
 * limit with no room held back, and a card that couldn't file tries again once the cause is gone.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover, approve } from "./scope.js";
import { register } from "./runner.js";
import { DatabaseSync } from "node:sqlite";
import { FLOW_GOAL_LIMIT, FLOW_INSTRUCTIONS_STORED, fitFlowText, flowAttachedMark, flowGoal, validateFlowDefinition } from "./flows.js";
import { advanceFlows, flowDefinitionOf, flowGoalCuts } from "./flow-engine.js";
import { storeEvidence } from "./evidence.js";
import { TASK_TEXT_LIMITS, validateTaskText } from "./task-text.js";

let dir: string, repo: string, store: Store, operator: string;
const now = new Date("2026-09-30T23:00:00Z");
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "flow-goal-")));
  repo = join(dir, "site");
  mkdirSync(repo);
  store = openStore(join(dir, "orders.db"));
  const added = addApprover(store, "operator", now);
  if (!added.ok) throw Error("account");
  operator = added.token;
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const ASK = "Read tonight's journey results and write up what broke, with the likeliest cause for each failure.\n\nResults:\n{{stage.nightly-journeys}}";
const drawing = (instructions: string) => ({ version: 1, start: "nightly-journeys", stages: [
  { id: "nightly-journeys", title: "Nightly journeys", kind: "inbox", next: "research" },
  { id: "research", title: "Research", kind: "report", instructions, next: "done" },
  { id: "done", title: "Done", kind: "done" },
] });
/** A script's output: 20,000 characters, with a recognisable start and end. */
const output = `START journeys run 2026-09-30\r\n${Array.from({ length: 400 }, (_, i) => `journey ${i}: checkout ${i % 7 === 0 ? "FAILED" : "ok"}`).join("\n")}`.padEnd(19_976, ".") + "\nEND 57 passed, 3 failed";

function cardInResearch(flow: number, description: string | null = null): number {
  const card = store.addFlowCard({ flow, title: "Nightly journeys, 30 September", description, stage: "research", by: "operator" }, now);
  store.updateFlowCard(card, { outputs: { "nightly-journeys": output } }, now);
  return card;
}

test("the task goal and exclusions take 8000 characters, and 8001 is refused with its length, not cut", () => {
  expect(FLOW_GOAL_LIMIT).toBe(8_000);
  expect(TASK_TEXT_LIMITS).toMatchObject({ text: 8_000, textBytes: 32_000 });
  expect(validateTaskText({ title: "Long", goal: "g".repeat(8_000), outOfScope: "n".repeat(8_000) })).toBeNull();
  expect(validateTaskText({ title: "Long", goal: "g".repeat(8_001) })).toMatchObject({ ok: false, message: "Goal is 8,001 characters; the limit is 8,000. Shorten it." });
  expect(validateTaskText({ title: "Long", goal: "ok", outOfScope: "n".repeat(8_001) })).toMatchObject({ ok: false, message: "Exclusions is 8,001 characters; the limit is 8,000. Shorten it." });
});

test("a 20,000-character script result is attached, not cut: the goal keeps every other detail whole and the agent gets it whole", () => {
  expect(output.length).toBe(20_000);
  const description = `Customers report the checkout total is off by a cent. ${"Steps: add two items, apply the code, pay. ".repeat(100)}`.trim();
  const flow = store.createFlow({ repo, name: "Nightly journeys", definitionJson: JSON.stringify(validateFlowDefinition(drawing(ASK))), by: "operator" }, now);
  const card = cardInResearch(flow, description);
  expect(advanceFlows(store, repo, now).filed).toHaveLength(1);
  const filed = store.getFlowCard(card)!;
  expect(filed.waiting).toBe("Filed as a task");
  const goal = store.getScope(filed.task!)!.goal;
  expect(goal.length).toBeLessThanOrEqual(FLOW_GOAL_LIMIT);
  // The zone's words whole, the output named where it is attached, the card's title and details whole.
  expect(goal).toBe(`${ASK.replace("{{stage.nightly-journeys}}", flowAttachedMark("What Nightly journeys found"))}\n\nThe card: Nightly journeys, 30 September\n\n${description}`);
  expect(goal).not.toContain("cut");
  // The research agent is given the whole result (fenced as untrusted by the brief).
  expect(flowGoalCuts(store, filed.task!, goal)).toEqual([{ label: "What Nightly journeys found", text: output }]);
});

test("an output kept whole on the card's discussion is given whole to the task after it, and a newer output drops it", () => {
  const flow = store.createFlow({ repo, name: "Nightly journeys", definitionJson: JSON.stringify(validateFlowDefinition(drawing(ASK))), by: "operator" }, now);
  const card = store.addFlowCard({ flow, title: "Nightly journeys, 30 September", description: null, stage: "research", by: "operator" }, now);
  // As a step leaves it (flow-steps.ts settle): what the next zones read points at the discussion; the card keeps it whole.
  const pointer = `This is 20,000 characters, more than the 12,000 a step passes on, so it is kept whole on the card's discussion: /flows/${flow}?card=${card}.`;
  store.updateFlowCard(card, { outputs: { "nightly-journeys": pointer }, attached: { "nightly-journeys": output } }, now);
  expect(advanceFlows(store, repo, now).filed).toHaveLength(1);
  const filed = store.getFlowCard(card)!;
  const goal = store.getScope(filed.task!)!.goal;
  expect(goal).toContain(pointer);
  expect(flowGoalCuts(store, filed.task!, goal)).toEqual([{ label: "What Nightly journeys found", text: output }]);
  // Waiting and task changes keep it; a new output for that zone replaces it.
  store.updateFlowCard(card, { waiting: "Working on it" }, now);
  expect(store.getFlowCard(card)!.attached).toEqual({ "nightly-journeys": output });
  store.updateFlowCard(card, { outputs: { "nightly-journeys": "All passed." } }, now);
  expect(store.getFlowCard(card)!.attached).toEqual({});
});

test("card details go into the goal whole up to the limit; beyond it the longest values are attached, the rest stay whole", () => {
  const card = { title: "Checkout rounding", description: "d".repeat(7_000), note: null, outputs: { a: "x".repeat(9_000), b: "short notes" } };
  const whole = fitFlowText("Fix {{card.title}}.\n{{card.description}}", card)!;
  expect(whole).toBe(`Fix Checkout rounding.\n${"d".repeat(7_000)}`);
  const goal = fitFlowText("Fix {{card.title}}.\n{{card.description}}\n{{stage.a}}\n{{stage.b}}\nKeep the tests.", card)!;
  expect(goal.length).toBeLessThanOrEqual(FLOW_GOAL_LIMIT);
  expect(goal).toBe(`Fix Checkout rounding.\n${"d".repeat(7_000)}\n${flowAttachedMark("What a found")}\nshort notes\nKeep the tests.`);
  expect(fitFlowText("Fix {{card.title}}.", card)).toBe("Fix Checkout rounding.");
});

test("instructions take the full 8000 characters with no room held back; the card's details are then attached", () => {
  const full = `${"Check every page and every form. ".repeat(250)}`.slice(0, 7_970) + "\n{{stage.nightly-journeys}}";
  expect(full.length).toBeLessThanOrEqual(8_000);
  const saved = validateFlowDefinition(drawing(full));
  expect(saved.stages[1]!.instructions).toBe(full);
  expect(() => validateFlowDefinition(drawing("a".repeat(8_001)))).toThrow("stages[1].instructions: over 8,000 characters");
  const goal = flowGoal(full, { title: "t".repeat(200), description: "d".repeat(2_000), note: "n".repeat(2_000), outputs: { "nightly-journeys": output } })!;
  expect(goal.length).toBeLessThanOrEqual(FLOW_GOAL_LIMIT);
  expect(goal.startsWith(full.slice(0, 7_970))).toBe(true);
  // A flow saved earlier is read whatever its length: a limit is for writing.
  const longer = `${"x".repeat(9_000)}\n{{stage.nightly-journeys}}`;
  expect(validateFlowDefinition(drawing(longer), { stored: true }).stages[1]!.instructions).toBe(longer);
});

test("a zone's 8000-character instructions are saved so 0.9.26 and earlier still open the flow, and read back whole", () => {
  // Those releases re-check a zone's instructions against 4000 characters on every read; a flow over it wouldn't load.
  const full = `${"Check every page and every form. ".repeat(250)}`.slice(0, 7_970) + "\n{{stage.nightly-journeys}}";
  // A character outside the basic plane right at the split stays whole.
  const astral = `${"a".repeat(FLOW_INSTRUCTIONS_STORED - 1)}\u{1F600}${"b".repeat(3_000)}`;
  const flow = store.createFlow({ repo, name: "Nightly journeys", definitionJson: JSON.stringify(validateFlowDefinition(drawing(full))), by: "operator" }, now);
  const raw = () => {
    const db = new DatabaseSync(join(dir, "orders.db"), { readOnly: true });
    try { return JSON.parse(String((db.prepare("SELECT definition_json FROM flow WHERE id = ?").get(flow) as { definition_json: string }).definition_json)) as { stages: Array<Record<string, unknown>> }; }
    finally { db.close(); }
  };
  const older = (stored: { stages: Array<Record<string, unknown>> }) => stored.stages.every(one => typeof one["instructions"] !== "string" || one["instructions"].trim().length <= FLOW_INSTRUCTIONS_STORED);
  expect(older(raw())).toBe(true);
  expect(raw().stages[1]!["instructions"]).toBe(full.slice(0, FLOW_INSTRUCTIONS_STORED));
  expect(flowDefinitionOf(store.getFlow(flow)!)!.stages[1]!.instructions).toBe(full);

  expect(store.saveFlow(flow, { name: "Nightly journeys", definitionJson: JSON.stringify(validateFlowDefinition(drawing(astral))), sawRevision: 1, by: "operator" }, now)).toBe(true);
  expect(older(raw())).toBe(true);
  expect(flowDefinitionOf(store.getFlow(flow)!)!.stages[1]!.instructions).toBe(astral);
  // Within the older limit, nothing about the saved flow changes.
  const short = JSON.stringify(validateFlowDefinition(drawing(ASK)));
  expect(store.saveFlow(flow, { name: "Nightly journeys", definitionJson: short, sawRevision: 2, by: "operator" }, now)).toBe(true);
  expect(JSON.stringify(raw())).toBe(short);
  expect(store.getFlow(flow)!.definitionJson).toBe(short);
});

test("a card that couldn't file its work says why, and files on a later pass once the cause is gone", () => {
  const long = `Investigate this carefully. ${"Check every page and every form. ".repeat(260)}\n\n{{stage.nightly-journeys}}`;
  expect(long.length).toBeGreaterThan(FLOW_GOAL_LIMIT);
  // Saved some other way: its instructions alone are over the limit.
  const flow = store.createFlow({ repo, name: "Nightly journeys", definitionJson: JSON.stringify(drawing(long)), by: "operator" }, now);
  const card = cardInResearch(flow);
  expect(advanceFlows(store, repo, now).filed).toEqual([]);
  const stuck = store.getFlowCard(card)!;
  expect(stuck.task).toBeNull();
  expect(stuck.waiting).toBe("Couldn't file the work: Research's instructions are too long for a task. Open the flow and shorten them. It tries again on the next pass.");
  // Still stuck on the next pass, without churn.
  advanceFlows(store, repo, new Date(now.getTime() + 60_000));
  expect(store.getFlowCard(card)).toMatchObject({ task: null, updatedAt: stuck.updatedAt });
  // Someone shortens the zone; the next pass files the work.
  expect(store.saveFlow(flow, { name: "Nightly journeys", definitionJson: JSON.stringify(validateFlowDefinition(drawing(ASK))), sawRevision: 1, by: "operator" }, now)).toBe(true);
  const later = new Date(now.getTime() + 120_000);
  expect(advanceFlows(store, repo, later).filed).toHaveLength(1);
  const filed = store.getFlowCard(card)!;
  expect(filed.waiting).toBe("Filed as a task");
  expect(store.getScope(filed.task!)!.goal.length).toBeLessThanOrEqual(FLOW_GOAL_LIMIT);
});

test("a research zone's items and full report reach the next zone, beside its summary", () => {
  const steps = { version: 1, start: "research", stages: [
    { id: "research", title: "Research", kind: "report", instructions: "Find what slows checkout.", next: "build" },
    { id: "build", title: "Build", kind: "task", instructions: "Fix these:\n{{stage.research.items}}\n\nSummary: {{stage.research}}\n\nReport:\n{{stage.research.report}}", next: "done" },
    { id: "done", title: "Done", kind: "done" },
  ] };
  const flow = store.createFlow({ repo, name: "Checkout", definitionJson: JSON.stringify(validateFlowDefinition(steps)), by: "operator" }, now);
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "operator", now);
  const card = store.addFlowCard({ flow, title: "Checkout is slow", description: null, stage: "research", by: "operator" }, now);
  expect(advanceFlows(store, repo, now).filed).toHaveLength(1);
  // The research task finishes with a scout's report: two items, one with a screenshot.
  const task = store.getFlowCard(card)!.task!;
  const ref = store.lookupRef(task)!.id;
  register(store, { name: "worker-1", host: "test", capacity: 4, repos: [repo], now, newToken: () => "tok-worker-1" });
  const approved = approve(store, task, "operator", now, store.getScope(task)!.digest, operator);
  if (!approved.ok) throw new Error(JSON.stringify(approved));
  const authority = store.routeAuthorityFor(ref, "builder");
  if (!authority?.ok) throw new Error("route fixture");
  const run = store.startRun({ taskRef: ref, leaseId: "lease-scout", runner: "worker-1", role: "scout", branch: "scout/checkout", worktree: "/pool/checkout", route: authority.stamp, now });
  const report = { title: "Checkout is slow in two places", summary: "The payment iframe and the tax lookup block the page.", report: "## Findings\nThe tax lookup runs on every keystroke.", followUps: [],
    items: [
      { title: "The payment iframe loads late", why: "It waits for three analytics scripts.", url: "https://shop.example.com/checkout", image: "checkout.png" },
      { title: "Tax lookup on every keystroke", why: "Each call takes 400 ms.\nIt blocks typing.", url: "https://shop.example.com/api/tax" },
    ],
    images: [{ file: "checkout.png", caption: "The checkout page", url: "https://shop.example.com/checkout" }] };
  storeEvidence(store, dir, run, "report", "report.json", Buffer.from(JSON.stringify(report)), "scout handoff (verified tree)", now);
  store.finishRun(run, { outcome: "built", reason: "report-delivered", now });
  store.setTaskState(task, "done", now);
  const later = new Date(now.getTime() + 60_000);
  advanceFlows(store, repo, later, { evidenceRoot: dir });
  const moved = store.getFlowCard(card)!;
  expect(moved.stage).toBe("build");
  expect(moved.outputs).toMatchObject({
    research: report.summary,
    "research.items": "1. The payment iframe loads late\n   It waits for three analytics scripts.\n   https://shop.example.com/checkout\n2. Tax lookup on every keystroke\n   Each call takes 400 ms. It blocks typing.\n   https://shop.example.com/api/tax",
    "research.report": report.report,
  });
  advanceFlows(store, repo, later, { evidenceRoot: dir });
  const goal = store.getScope(store.getFlowCard(card)!.task!)!.goal;
  expect(goal).toContain("Fix these:\n1. The payment iframe loads late");
  expect(goal).toContain("https://shop.example.com/api/tax");
  expect(goal).toContain(`Summary: ${report.summary}`);
  expect(goal).toContain("Report:\n## Findings\nThe tax lookup runs on every keystroke.");
});
