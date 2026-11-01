/**
 * Starter kits: one click sets up a subagent, the flow it works and its
 * safe triggers; a second click opens what's there instead of doubling it; the
 * checklist says what's left; and a sample card puts the subagent to work.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { run as exec } from "./exec.js";
import { runFlowSteps, type StepIo } from "./flow-steps.js";
import { flowDefinitionOf, draftFor } from "./flow-engine.js";
import { addKitSample, kitChecklist, kitInstalled, kitOf, KITS, setUpKit } from "./kits.js";
import { addToolTo, validateToolSpec } from "./project-tools.js";
import type { TurnRequest, TurnRunner } from "./subagents.js";

const T0 = new Date("2026-09-26T22:00:00.000Z");
let dir: string, repo: string, store: Store;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-kits-")));
  repo = join(dir, "shop");
  store = openStore(join(dir, "orders.db"));
  if (!addApprover(store, "alex", T0).ok) throw new Error("bootstrap");
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

test("every kit sets up a subagent, a valid flow it works, and its buttons; a second click changes nothing", async () => {
  for (const kit of KITS) {
    const made = await setUpKit(store, kit, repo, "alex", T0, dir);
    expect(made, kit.id).toMatchObject({ ok: true });
    const set = kitInstalled(store, kit, repo)!;
    expect(set.mate.handle).toBe(kit.subagent.handle);
    expect(set.flow).toMatchObject({ name: kit.flowName, owner: "alex" });
    const definition = flowDefinitionOf(set.flow)!;
    expect(definition.stages.some(one => one.subagent === kit.subagent.handle), kit.id).toBe(true);
    expect(store.flowTriggers(set.flow.id).map(one => JSON.parse(one.configJson).label)).toEqual(kit.buttons.map(one => one.label));
    expect(await setUpKit(store, kit, repo, "alex", T0, dir)).toMatchObject({ ok: true, said: `${kit.name} is already set up here.`, flow: set.flow.id });
  }
  expect(store.listFlows([repo])).toHaveLength(KITS.length);
  expect(store.subagents([repo]).map(one => one.handle).sort()).toEqual(["ada", "leo", "maya", "theo"]);
  // The decision after a subagent's zone shows what it wrote as the draft to check.
  const support = kitInstalled(store, kitOf("support-desk")!, repo)!;
  const definition = flowDefinitionOf(support.flow)!;
  expect(draftFor(definition, definition.stages.find(one => one.title === "You check the reply")!)?.id).toBe("answer");
});

test("the checklist says what's left, and the sample card puts the subagent to work at once", async () => {
  const kit = kitOf("support-desk")!;
  await setUpKit(store, kit, repo, "alex", T0, dir);
  expect(kitChecklist(store, kit, repo, dir).map(one => [one.id, one.done, one.action ?? null])).toEqual([
    ["subagent", true, null], ["flow", true, null], ["email", false, null],
    ["tool-stripe", false, "connect"], ["tool-intercom", false, "connect"], ["sample", false, "sample"],
  ]);
  const tried = addKitSample(store, kit, repo, "alex", T0);
  expect(tried).toMatchObject({ ok: true });
  const set = kitInstalled(store, kit, repo)!;
  const [card] = store.flowCards(set.flow.id, false);
  expect(card).toMatchObject({ title: kit.sample.title, stage: "answer" });
  const prompts: string[] = [];
  const maya: TurnRunner = async (request: TurnRequest) => {
    prompts.push(request.prompt);
    return { ok: true, value: { action: "route", answer: "Reply", text: "Hi Priya, your lamp shipped on the 15th and arrives tomorrow. The team", note: "", question: "", options: [], reason: "Tracking shows it in transit.", tool: "", input: "", remember: "" }, ms: 10 };
  };
  const io: StepIo = { gh: exec, git: exec, shell: exec, fetch, dir, scratch: join(dir, "scratch"), base: "main", toolHome: dir, subagent: maya };
  await runFlowSteps(store, repo, T0, io);
  expect(prompts[0]).toContain("Where's my order? It's been 9 days");
  expect(store.getFlowCard(card!.id)).toMatchObject({ stage: "check", outputs: { answer: "Hi Priya, your lamp shipped on the 15th and arrives tomorrow. The team" } });
  expect(kitChecklist(store, kit, repo, dir).find(one => one.id === "sample")).toMatchObject({ done: true });
});

test("a kit's subagent gets its connected tools only on the person's proof; without it the checklist says to let it use each", async () => {
  const kit = kitOf("support-desk")!;
  const io = { toolHome: dir, listTools: async () => ({ ok: false as const, problem: "offline" }) };
  const connect = (project: string) => {
    expect(addToolTo(store, project, validateToolSpec({ name: "stripe", command: process.execPath, args: [], secrets: [], about: "Stripe" }), "test", "alex", T0, { home: dir })).toMatchObject({ ok: true });
    store.recordProjectToolTest(project, "stripe", JSON.stringify({ at: T0.toISOString(), ok: true, tools: ["list_payments", "refund"], problem: null }));
  };
  connect(repo);
  await setUpKit(store, kit, repo, "alex", T0, dir, io);
  const mate = kitInstalled(store, kit, repo)!.mate;
  expect(store.subagentGrant(mate.id, "stripe")).toBeNull();
  expect(kitChecklist(store, kit, repo, dir).find(one => one.id === "tool-stripe")).toMatchObject({ done: false, said: expect.stringContaining("Let Maya use Stripe") });
  // With the person's proof (a password, or the session under Passwordless): granted at its defaults.
  const other = join(dir, "studio");
  connect(other);
  await setUpKit(store, kit, other, "alex", T0, dir, io, { widening: "proved" });
  expect(store.subagentGrant(kitInstalled(store, kit, other)!.mate.id, "stripe")?.rules).toEqual({ list_payments: { use: "free" }, refund: { use: "ask" } });
});
