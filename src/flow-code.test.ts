/**
 * Code steps (v90): project scripts in shell, Python and Node — written in
 * the library or a file in the project — run with no AI, given the card as
 * data, passing on what they print and picking where the card goes next;
 * saved secrets as variables that never reach a card or a log; the agents'
 * fence around them; and a schedule that runs a script to make cards. Real
 * processes (sh, python3, node) in a real git repository.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { run as exec, type ExecResult } from "./exec.js";
import type { Runner } from "./backend.js";
import { flowFromSteps } from "./flows.js";
import { runFlowSteps, type StepIo } from "./flow-steps.js";
import { saveScript, validateScript } from "./flow-scripts.js";
import { addFlowTriggerTo, checkFlowTriggerNow, runFlowTriggers, type TriggerIo } from "./flow-triggers.js";
import { setFlowSecret } from "./flow-secrets.js";
import { cardsFromOutput, codeOutput } from "./flow-code.js";
import { linuxFenceAvailable, macosFenceAvailable } from "./agent-fence.js";

const T0 = new Date("2026-09-25T09:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const ok = (): ExecResult => ({ code: 0, stdout: "", stderr: "", timedOut: false, notFound: false });

let dir: string, repo: string, store: Store;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-flow-code-")));
  repo = join(dir, "shop");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "README.md"), "Shop\n");
  writeFileSync(join(repo, "scripts", "count.sh"), 'printf "%s has %s words\\n" "$FLOW_CARD_TITLE" "$(wc -w < "$FLOW_INPUT" | tr -d " ")"\nls "$FLOW_PROJECT"\n');
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "seed"]);
  store = openStore(join(dir, "orders.db"));
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "fixture", T0);
  if (!addApprover(store, "alex", T0).ok) throw new Error("bootstrap");
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const flowOf = (steps: Parameters<typeof flowFromSteps>[0]) => store.createFlow({ repo, name: "Leads", definitionJson: JSON.stringify(flowFromSteps(steps, null)), by: "alex" }, T0);
const io = (extra: Partial<StepIo> = {}): StepIo => ({ gh: vi.fn<Runner>(async () => ok()), git: exec, shell: exec, fetch: vi.fn() as unknown as typeof fetch, dir, scratch: join(dir, "scratch"), base: "main", ...extra });
const save = (input: Parameters<typeof validateScript>[0]) => { const saved = saveScript(store, repo, input, "alex", T0); if (!saved.ok) throw new Error(saved.message); };

describe("a code step", () => {
  test("Python gets the card as data, what it prints is the step's result a later zone reads, and its goto line picks the next zone", async () => {
    save({ name: "classify", about: "Sorts leads by company size", language: "python", body: [
      "import json, sys",
      "card = json.load(sys.stdin)['card']",
      "size = 500 if 'Acme' in card['title'] else 5",
      "print(f\"{card['title']}: about {size} people ({card['email']})\")",
      "print('goto: Big' if size > 100 else 'goto: Small')",
    ].join("\n") });
    const flow = flowOf([
      { title: "Inbox", kind: "inbox" },
      { id: "classify", title: "Classify", kind: "check", script: "classify", runIn: "folder", routes: [{ answer: "Big", goesTo: "Call them" }, { answer: "Small", goesTo: "Send a guide" }] },
      { title: "Call them", kind: "inbox" },
      { title: "Send a guide", kind: "notify", message: "Guide for: {{stage.classify}}" },
    ]);
    // Text that would do something if it were ever pasted into a command.
    const marker = join(dir, "pwned");
    const title = `Acme wants a demo $(touch ${marker}) \`touch ${marker}\``;
    const card = store.addFlowCard({ flow, title, description: "Reach sam@acme.example", stage: "classify", by: "alex" }, T0);
    expect(await runFlowSteps(store, repo, at(1), io())).toEqual({ ran: 1, problems: [] });
    expect(store.getFlowCard(card)).toMatchObject({ stage: "call-them", outputs: { classify: `${title}: about 500 people (sam@acme.example)` } });
    expect(store.flowStepRun(card, 1)).toMatchObject({ state: "passed", result: "classify ran and picked Big.", exitCode: 0 });
    expect(existsSync(marker)).toBe(false);
    const small = store.addFlowCard({ flow, title: "Two-person bakery", description: null, stage: "classify", by: "alex" }, T0);
    await runFlowSteps(store, repo, at(2), io());
    expect(store.getFlowCard(small)!.stage).toBe("send-a-guide");
  });

  test("Node reads $FLOW_INPUT and a saved secret; the secret's value never reaches the card or the log, and a missing one is said", async () => {
    save({ name: "enrich", about: "Looks the company up", language: "node", body: [
      "import { readFileSync } from 'node:fs';",
      "const input = JSON.parse(readFileSync(process.env.FLOW_INPUT, 'utf8'));",
      "console.log(`Looked up ${input.card.title} with key ${process.env.CRM_KEY}`);",
      "console.error(`debug: ${process.env.CRM_KEY}`);",
    ].join("\n") });
    const flow = flowOf([{ title: "Inbox", kind: "inbox" }, { id: "enrich", title: "Enrich", kind: "check", script: "enrich", runIn: "folder", secrets: ["CRM_KEY"] }]);
    const card = store.addFlowCard({ flow, title: "Globex", description: null, stage: "enrich", by: "alex" }, T0);
    await runFlowSteps(store, repo, at(1), io());
    // It waits, saying for what, and runs on its own once the secret is saved.
    expect(store.getFlowCard(card)).toMatchObject({ stage: "enrich", waiting: "enrich needs the secret CRM_KEY. Save it on the zone." });
    expect(store.flowStepRun(card, 1)).toBeNull();
    // Made when the test runs, never written out.
    const value = ["crm", "k".repeat(18)].join("_");
    expect(setFlowSecret(dir, repo, "CRM_KEY", value).ok).toBe(true);
    await runFlowSteps(store, repo, at(3), io());
    expect(store.getFlowCard(card)!.outputs["enrich"]).toBe("Looked up Globex with key [secret]");
    const run = store.flowStepRun(card, 1)!;
    expect(run.log).toContain("debug: [secret]");
    expect(`${run.log}${JSON.stringify(store.getFlowCard(card))}`).not.toContain(value);
  });

  test("a file in the project runs from a clean folder; a goto the zone doesn't know, a failure and a missing file each say so", async () => {
    save({ name: "count", about: "Counts the card's words", file: "scripts/count.sh" });
    save({ name: "wander", about: "Picks an answer that isn't there", body: "echo hi\necho 'goto: Elsewhere'" });
    save({ name: "breaks", about: "Fails", language: "python", body: "import sys\nprint('half done')\nsys.exit('the API said no')" });
    save({ name: "gone", about: "Runs a file that isn't there", file: "scripts/missing.sh" });
    const flow = flowOf([
      { title: "Inbox", kind: "inbox" },
      { id: "count", title: "Count", kind: "check", script: "count", runIn: "folder" },
      { id: "wander", title: "Wander", kind: "check", script: "wander", runIn: "folder", routes: [{ answer: "Here", goesTo: "Inbox" }], ifFails: "Inbox" },
    ]);
    const card = store.addFlowCard({ flow, title: "Tally", description: "one two three", stage: "count", by: "alex" }, T0);
    await runFlowSteps(store, repo, at(1), io());
    const counted = store.getFlowCard(card)!;
    expect(counted.stage).toBe("wander");
    expect(counted.outputs["count"]).toMatch(/^Tally has \d+ words\nREADME\.md\nscripts$/);
    await runFlowSteps(store, repo, at(2), io());
    expect(store.getFlowCard(card)).toMatchObject({ stage: "inbox", note: "wander picked “Elsewhere”, but this zone has no answer called that (it has Here)." });
    const second = flowOf([{ title: "Inbox", kind: "inbox" }, { id: "breaks", title: "Breaks", kind: "check", script: "breaks", runIn: "folder", ifFails: "Inbox" }, { id: "gone", title: "Gone", kind: "check", script: "gone", runIn: "folder", ifFails: "Inbox" }]);
    const failing = store.addFlowCard({ flow: second, title: "Try", description: null, stage: "breaks", by: "alex" }, T0);
    const missing = store.addFlowCard({ flow: second, title: "Try too", description: null, stage: "gone", by: "alex" }, T0);
    await runFlowSteps(store, repo, at(3), io());
    expect(store.getFlowCard(failing)).toMatchObject({ stage: "inbox", note: "breaks failed (exit 1).\nhalf done\nthe API said no", outputs: { breaks: "half done" } });
    expect(store.getFlowCard(missing)).toMatchObject({ stage: "inbox", note: "gone runs scripts/missing.sh, which isn't a file in the project." });
    // No run leaves its folder behind.
    expect(execFileSync("ls", [join(dir, "scratch")], { encoding: "utf8" }).trim()).toBe("");
  });

  test.runIf(macosFenceAvailable() || linuxFenceAvailable())("a script can't read Toolroll's own database, like an agent can't", async () => {
    save({ name: "peek", about: "Tries to read the database", body: `if cat "${join(dir, "orders.db")}" > /dev/null 2>&1; then echo read; else echo denied; fi` });
    const flow = flowOf([{ title: "Inbox", kind: "inbox" }, { id: "peek", title: "Peek", kind: "check", script: "peek", runIn: "folder" }]);
    const card = store.addFlowCard({ flow, title: "Look", description: null, stage: "peek", by: "alex" }, T0);
    await runFlowSteps(store, repo, at(1), io());
    expect(store.getFlowCard(card)!.outputs["peek"]).toBe("denied");
  });

  test("what counts as output: the goto line comes off, secrets and key-shaped lines are blanked, long output is kept whole", () => {
    expect(codeOutput("Result\ngoto: Big\n", {})).toEqual({ output: "Result", goTo: "Big" });
    expect(codeOutput("goto: nowhere in particular at all, really, truly too long for an answer\n", {})).toEqual({ output: "goto: nowhere in particular at all, really, truly too long for an answer", goTo: null });
    expect(codeOutput("token is hunter22secret\n", { PASS: "hunter22secret" }).output).toBe("token is [secret]");
    // Never cut: the step passes it on whole up to 12,000 and attaches longer to the card (flow-steps settle).
    expect(codeOutput("x".repeat(12_000), {}).output).toBe("x".repeat(12_000));
    expect(codeOutput(`START\n${"x".repeat(20_000)}\nEND`, {}).output).toBe(`START\n${"x".repeat(20_000)}\nEND`);
    expect(cardsFromOutput('[{"title":"One","key":1},{"title":"Two","description":"d","email":"a@b.example"},{"nope":true}]')).toEqual([
      { key: "key:1", title: "One", description: null }, { key: "item:Two\nd\n\na@b.example", title: "Two", description: "d\n\na@b.example" }]);
    expect(cardsFromOutput('{"title":"A"}\n{"title":"B","key":"b"}\nplain line\n\n')).toEqual([
      { key: "item:A\n", title: "A", description: null }, { key: "key:b", title: "B", description: null }, { key: "line:plain line", title: "plain line", description: null }]);
  });
});

describe("a schedule that runs a script", () => {
  test("each item it prints becomes a card, once; Run now runs it without moving the schedule", async () => {
    save({ name: "new-orders", about: "Lists new orders", language: "python", body: [
      "import json, os",
      "print(json.dumps({'title': 'Order 41', 'key': 41}))",
      "print(json.dumps({'title': 'Order 42', 'key': 42, 'description': 'Two mugs'}))",
      "print(json.dumps({'title': f\"Ran for {os.environ['FLOW_NAME']}\", 'key': 'name'}))",
    ].join("\n") });
    const flow = flowOf([{ title: "Inbox", kind: "inbox" }]);
    const bad = addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "schedule", schedule: "every 2 hours", script: "nope" }, "alex", T0, dir);
    expect(bad).toEqual({ ok: false, message: "There's no script called nope in this project. Make it on the flow's Scripts panel first." });
    const made = addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "schedule", schedule: "every 2 hours", script: "new-orders" }, "alex", T0, dir);
    if (!made.ok) throw new Error(made.message);
    const trigger = () => store.flowTriggers(flow)[0]!;
    const tio: TriggerIo = { gh: exec, fetch, dir, shell: exec, scratch: join(dir, "scratch") };
    expect(await runFlowTriggers(store, repo, at(1), tio)).toMatchObject({ added: 0 });
    const nextAt = trigger().nextAt!;
    expect(await checkFlowTriggerNow(store, trigger(), at(3), tio)).toEqual({ ok: true, said: "Added 3 cards." });
    expect(trigger().nextAt).toBe(nextAt);
    expect(store.flowCards(flow, true).map(one => [one.title, one.description, one.createdBy, one.source?.label]).reverse()).toEqual([
      ["Order 41", null, "The new-orders script", "The new-orders script"], ["Order 42", "Two mugs", "The new-orders script", "The new-orders script"], ["Ran for Leads", null, "The new-orders script", "The new-orders script"]]);
    // On schedule it runs again: nothing it already made is made twice.
    expect(await runFlowTriggers(store, repo, new Date(Date.parse(nextAt) + 1000), tio)).toMatchObject({ added: 0, problems: [] });
    expect(trigger().lastOutcome).toBe("Nothing new.");
    expect(Date.parse(trigger().nextAt!)).toBeGreaterThan(Date.parse(nextAt));
  });
});

test("a step named the way the lead wrote it (draftReply, Draft reply) is found from another step's words", () => {
  const definition = flowFromSteps([
    { title: "New questions", kind: "inbox" },
    { id: "draftReply", title: "Draft reply", kind: "draft", instructions: "Answer {{card.title}}" },
    { title: "Approve reply", kind: "approval", decider: "owner" },
    { title: "Post to team chat", kind: "notify", message: "{{stage.draftReply}} / {{stage.Draft reply}} / {{ stage.draft_reply }} / {{stage.nothing}}" },
  ], null);
  expect(definition.stages.find(one => one.kind === "draft")!.id).toBe("draftreply");
  expect(definition.stages.find(one => one.kind === "notify")!.message).toBe("{{stage.draftreply}} / {{stage.draftreply}} / {{stage.draftreply}} / {{stage.nothing}}");
});
