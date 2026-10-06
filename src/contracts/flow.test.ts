import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { readTriggerConfig, readTriggerSettings, validateTriggerConfig } from "../flow-triggers.js";
import { parseFlowFile } from "../flow-share.js";
import { FLOW_TEMPLATES, flowDefinitionForStore, flowDefinitionFromStore, flowDigest, flowFromSteps, readFlowDefinition, readFlowSteps, validateFlowDefinition, withZoneNames, type FlowDefinition } from "../flows.js";
import { MATE_TOOLS } from "../mate-tools.js";
import { openStore, type Store } from "../store.js";
import { addApprover } from "../scope.js";
import { TEXT_LIMITS } from "../text-limits.js";
import { parseContract, toModelSchema } from "./contract.js";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import {
  FLOW_ALIASES, FLOW_STAGE_KINDS, FLOW_TRIGGER_KINDS, flowDefinitionSchema, flowFileJsonSchema, flowFileSchema, flowStepsSchema, leadTriggerSchema,
  savedFlowDefinitionSchema, triggerConfigSchema, triggerInputSchema,
} from "./flow.js";
import { PROPOSE_FLOW_MODEL_SCHEMA, proposeFlowInputSchema } from "./flow-propose.js";

type Recorded = { name: string; input: unknown; stored: boolean; canonical: string; digest: string; forStore: string | null };
const fixture = <T>(name: string) => JSON.parse(readFileSync(new URL(`../../test/fixtures/flows/${name}`, import.meta.url), "utf8")) as T;
const drawings = fixture<{ valid: Recorded[]; invalid: { name: string; input: unknown }[] }>("stored-definitions.json");
const stepLists = fixture<{ valid: { name: string; steps: unknown; previous: FlowDefinition | null; canonical: string; digest: string }[]; invalid: { name: string; steps: unknown }[] }>("steps.json");
const files = fixture<{ files: { name: string; json: string; imported: string | null; refused: string | null }[] }>("flow-files.json");
const triggers = fixture<{ sourceFlow: number; triggers: { name: string; input: Record<string, unknown>; config: unknown }[] }>("trigger-configs.json");

const verdict = <T>(read: { ok: true; value: T } | { ok: false; issues: readonly { line: string }[] }): SampleVerdict => read.ok ? { ok: true } : { ok: false, lines: read.issues.map(one => one.line) };
const thrown = (run: () => unknown): SampleVerdict => { try { run(); return { ok: true }; } catch (error) { return { ok: false, lines: (error as Error).message.split("\n") }; } };
const lines = (verdict: SampleVerdict) => verdict.ok ? [] : verdict.lines;
const zone = { x: 0, y: 0, w: 260, h: 300, color: "slate" };
/** Recorded step lists that used a key their kind doesn't take (a sort's ifFails, a wait's remindAfter): refused by name now. */
const TIGHTENED = ["sort with a fraction and the fallback ifFails", "merge true, wait as minutes, remind none"];
const base = { instructions: null, planning: null, approver: null, message: null, close: null, script: null, sort: null, next: null, onFail: null };

describe("the saved drawing", () => {
  it("holds: every drawing saved since 0.9.0, every template and gallery flow loads, malformed ones are refused by path", () => {
    expect(drawings.valid.length).toBeGreaterThanOrEqual(40);
    // Saved earlier: read as every release has (a key a later release dropped is set aside, long instructions kept).
    assertContract({
      schema: savedFlowDefinitionSchema,
      read: input => verdict(readFlowDefinition(structuredClone(input), { stored: true })),
      valid: drawings.valid.filter(one => one.stored).map(one => ({ name: one.name, input: one.input })),
      invalid: [{ name: "a drawing from a newer Toolroll", input: { version: 2, start: "a", stages: [{ id: "a", title: "A", kind: "inbox" }] }, paths: ["version"] }],
    });
    // Written now (the canvas, steps once drawn): the same, with today's limits.
    assertContract({
      schema: flowDefinitionSchema,
      read: input => verdict(readFlowDefinition(structuredClone(input))),
      valid: drawings.valid.filter(one => !one.stored).map(one => ({ name: one.name, input: one.input })),
      invalid: [
        { name: "a sort answer leading nowhere", input: { version: 1, stages: [{ id: "a", title: "A", kind: "sort", sort: { question: "q", answers: [{ answer: "x", to: "b" }, { answer: "y", to: "c" }] } }, { id: "b", title: "B", kind: "done" }] }, paths: ["stages[0].sort.answers[1].to"] },
        { name: "a build with nothing to do", input: { version: 1, stages: [{ id: "a", title: "A", kind: "task" }] }, paths: ["stages[0].instructions"] },
        { name: "an unknown kind", input: { version: 1, stages: [{ id: "a", title: "A", kind: "teleport" }] }, paths: ["stages[0].kind"] },
        ...drawings.invalid.map(one => ({ name: one.name, input: one.input, paths: [] })),
      ],
    });
    expect(drawings.invalid.every(one => !readFlowDefinition(structuredClone(one.input)).ok)).toBe(true);
  });

  it("reads each saved drawing to exactly the JSON, digest and stored form the pre-Zod reader made", () => {
    for (const one of drawings.valid) {
      const read = validateFlowDefinition(structuredClone(one.input), { stored: one.stored });
      const json = JSON.stringify(read);
      expect(json, one.name).toBe(one.canonical);
      expect(flowDigest(read), one.name).toBe(one.digest);
      expect(flowDefinitionForStore(json) === json ? null : flowDefinitionForStore(json), one.name).toBe(one.forStore);
      // What the store writes reads back whole (a rollback reads its first part; this release joins it again).
      expect(JSON.stringify(validateFlowDefinition(JSON.parse(flowDefinitionFromStore(one.forStore ?? json)), { stored: true })), one.name).toBe(one.canonical);
    }
    expect(drawings.valid.some(one => one.forStore !== null)).toBe(true);
  });

  it("keeps instructions saved longer than today's limit, and refuses them when written now", () => {
    const long = drawings.valid.find(one => one.name.startsWith("instructions longer"))!;
    expect(readFlowDefinition(structuredClone(long.input), { stored: true }).ok).toBe(true);
    expect(lines(verdict(readFlowDefinition(structuredClone(long.input))))).toEqual([`stages[0].instructions: over ${TEXT_LIMITS.flowInstructions.toLocaleString("en-US")} characters`]);
  });

  it("tells the canvas which zone a refusal is about, keeping its path", () => {
    const drawn = { version: 1, stages: [{ id: "a", title: "Inbox", kind: "inbox", next: "b" }, { id: "b", title: "Build", kind: "task" }] };
    const read = readFlowDefinition(drawn);
    expect(read.ok ? "" : withZoneNames(read.issues.map(one => one.line), drawn)).toBe("Build · stages[1].instructions: required");
  });

  it("refuses an unknown key on every kind of zone, by its path", () => {
    for (const kind of FLOW_STAGE_KINDS) {
      const read = parseContract(flowDefinitionSchema, { version: 1, start: "a", stages: [{ id: "a", title: "A", kind, zone, ...base, bogus: 1 }] });
      expect(lines(verdict(read)), kind).toContain("stages[0]: unknown key 'bogus'");
    }
  });
});

describe("steps", () => {
  it("holds: the JSON Schema round trip loses nothing; starters, kits, the gallery and the lead's steps parse; malformed ones are refused by path", () => {
    assertContract({
      schema: flowStepsSchema,
      read: input => thrown(() => flowFromSteps(structuredClone(input), null)),
      valid: stepLists.valid.filter(one => one.previous === null && !TIGHTENED.includes(one.name)).map(one => ({ name: one.name, input: one.steps })),
      invalid: [
        { name: "a route's to", input: [{ title: "Run", kind: "check", script: "triage", routes: [{ answer: "bug", to: "Done" }] }], paths: ["steps[0].routes[0]", "steps[0].routes[0].goesTo"] },
        { name: "onFail for ifFails", input: [{ title: "Build", kind: "task", onFail: "Build" }], paths: ["steps[0]"] },
        { name: "a sort's ifFails (a sort's failure path is ifNotSure)", input: [{ title: "S", kind: "sort", question: "q", answers: [{ answer: "a", goesTo: "A" }, { answer: "b", goesTo: "A" }], ifFails: "A" }, { title: "A", kind: "inbox" }], paths: ["steps[0]"] },
        { name: "a wait's reminder (a wait has its own time)", input: [{ title: "W", kind: "wait", remindAfter: "1 day" }], paths: ["steps[0]"] },
        { name: "a field another kind has", input: [{ title: "Hold", kind: "inbox", planning: "skip" }], paths: ["steps[0]"] },
        { name: "an unknown kind", input: [{ title: "x", kind: "teleport" }], paths: ["steps[0].kind"] },
        { name: "no kind", input: [{ title: "x" }], paths: ["steps[0].kind"] },
        { name: "a sort with one answer", input: [{ title: "S", kind: "sort", answers: [{ answer: "a", goesTo: "x" }] }], paths: ["steps[0].answers"] },
        { name: "a choice with five options", input: [{ title: "C", kind: "choose", options: [1, 2, 3, 4, 5].map(n => ({ label: `o${n}` })) }], paths: ["steps[0].options"] },
        { name: "a merge that isn't a method", input: [{ title: "P", kind: "pull-request", merge: "fast-forward" }], paths: ["steps[0].merge"] },
        { name: "no steps", input: [], paths: ["steps"] },
        ...stepLists.invalid.map(one => ({ name: one.name, input: one.steps, paths: [] })),
      ],
    });
    expect(stepLists.invalid.every(one => !thrown(() => flowFromSteps(structuredClone(one.steps), null)).ok)).toBe(true);
  });

  it("make exactly the drawings the pre-Zod flowFromSteps made, edits keeping steps by id included", () => {
    for (const one of stepLists.valid) {
      const run = () => flowFromSteps(structuredClone(one.steps), one.previous);
      if (TIGHTENED.includes(one.name)) {
        // Tightened on purpose (CHANGELOG 0.9.35): a key a kind doesn't take is refused by name, not silently used or ignored.
        expect(lines(thrown(run)), one.name).toEqual([expect.stringMatching(/^steps\[\d\]: unknown key '(ifFails|remindAfter)'/)]);
        continue;
      }
      const made = run();
      expect(JSON.stringify(made), one.name).toBe(one.canonical);
      expect(flowDigest(made), one.name).toBe(one.digest);
    }
  });

  it("names the field a wrong key meant, and the step's own words for a drawing's problem", () => {
    expect(lines(thrown(() => flowFromSteps([{ title: "Run", kind: "check", script: "triage", routes: [{ answer: "bug", to: "Done" }] }])))).toEqual([
      "steps[0].routes[0].goesTo: required",
      "steps[0].routes[0]: unknown key 'to' (did you mean goesTo?)",
    ]);
    expect(lines(thrown(() => flowFromSteps([{ title: "Build", kind: "task", onFail: "Build" }])))).toEqual(["steps[0]: unknown key 'onFail' (did you mean ifFails?)"]);
    expect(lines(thrown(() => flowFromSteps([{ title: "S", kind: "sort", question: "q", answers: [{ answer: "a", goesTo: "A" }, { answer: "b", goesTo: "A" }], ifFails: "A" }, { title: "A", kind: "inbox" }])))).toEqual(["steps[0]: unknown key 'ifFails' (did you mean ifNotSure?)"]);
    expect(lines(thrown(() => flowFromSteps([{ title: "S", kind: "sort", question: "q", answers: [{ answer: "a", goesTo: "A" }, { answer: "b", goesTo: "Nowhere" }] }, { title: "A", kind: "inbox" }])))).toEqual(["steps[0].answers[1].goesTo: there's no step called Nowhere"]);
    expect(lines(thrown(() => flowFromSteps([{ title: "T", kind: "tool", server: "s", tool: "t", args: "[1]" }])))).toEqual(["steps[0].args: must be a JSON object, like {\"text\": \"{{stage.draft}}\"}"]);
    expect(lines(thrown(() => flowFromSteps([{ title: "Hold", kind: "inbox", remindAfter: "1 day", thenMoveTo: "Hold" }])))).toEqual(["steps[0].thenMoveTo: can't lead back into the same zone"]);
  });

  it("refuses an unknown key on every kind of step, by its path", () => {
    for (const kind of FLOW_STAGE_KINDS) expect(lines(verdict(readFlowSteps([{ title: "A", kind, bogus: 1 }]))), kind).toEqual(["steps[0]: unknown key 'bogus'"]);
  });
});

describe("the flow file", () => {
  it("holds: every exported template and gallery flow parses, docs/flow-file.schema.json is this schema, malformed files are refused by path", () => {
    expect(files.files.length).toBeGreaterThanOrEqual(30);
    const good = JSON.parse(files.files[0]!.json) as Record<string, unknown> & { zones: Record<string, unknown>[] };
    assertContract({
      schema: flowFileSchema,
      read: input => thrown(() => parseFlowFile(JSON.stringify(input))),
      valid: [
        ...files.files.map(one => ({ name: one.name, input: JSON.parse(one.json) as unknown })),
        { name: "a script that leaves its language and time to the defaults", input: { ...good, scripts: [{ name: "lint", about: "Lints", body: "npm run lint" }] } },
      ],
      invalid: [
        { name: "a route's to", input: { ...good, zones: [{ id: "a", title: "A", kind: "check", script: "lint", routes: [{ answer: "x", to: "b" }] }, { id: "b", title: "B", kind: "done" }] }, paths: ["zones[0].routes[0]", "zones[0].routes[0].goesTo"] },
        { name: "onFail", input: { ...good, zones: [{ ...good.zones[0], onFail: "inbox" }, ...good.zones.slice(1)] }, paths: ["zones[0]"] },
        { name: "an unknown trigger setting", input: { ...good, triggers: [{ kind: "button", label: "Go", lable: "x" }] }, paths: ["triggers[0]"] },
        { name: "a trigger kind no file carries", input: { ...good, triggers: [{ kind: "flow", flow: 3 }] }, paths: ["triggers[0].kind"] },
        { name: "a newer file", input: { ...good, version: 2 }, paths: ["version"] },
        { name: "a key the file doesn't have", input: { ...good, cards: [] }, paths: ["payload"] },
      ],
    });
    expect(JSON.parse(readFileSync(new URL("../../docs/flow-file.schema.json", import.meta.url), "utf8"))).toEqual(flowFileJsonSchema());
  });

  it("says which key a wrong one meant", () => {
    const good = JSON.parse(files.files[0]!.json) as Record<string, unknown>;
    const refused = (input: unknown) => lines(thrown(() => parseFlowFile(JSON.stringify(input))));
    expect(refused({ ...good, zones: [{ id: "a", title: "A", kind: "check", script: "lint", routes: [{ answer: "x", to: "b" }], onFail: "b" }, { id: "b", title: "B", kind: "done" }] })).toEqual([
      "zones[0].routes[0].goesTo: required",
      "zones[0].routes[0]: unknown key 'to' (did you mean goesTo?)",
      "zones[0]: unknown key 'onFail' (did you mean ifFails?)",
    ]);
  });
});

describe("triggers", () => {
  let dir: string, store: Store;
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "so-flow-contract-")));
    const repo = join(dir, "shop");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:acme/shop.git"]);
    store = openStore(join(dir, "orders.db"));
    store.upsertProject(repo, "shop", new Date("2026-10-01T09:00:00.000Z"));
    if (!addApprover(store, "alex", new Date("2026-10-01T09:00:00.000Z")).ok) throw new Error("alex");
  });
  afterAll(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  it("hold: settings as given and configs as saved, one schema per kind; unknown keys are refused by path", () => {
    assertContract({
      schema: triggerInputSchema,
      read: input => verdict(readTriggerSettings(input)),
      valid: triggers.triggers.map(one => ({ name: one.name, input: one.input })),
      invalid: [
        ...FLOW_TRIGGER_KINDS.filter(kind => kind !== "chat").map(kind => ({ name: `${kind} with an unknown key`, input: { kind, bogus: 1 }, paths: ["payload"] })),
        { name: "a button's label left out", input: { kind: "button" }, paths: ["label"] },
        { name: "a kind no trigger has", input: { kind: "fax" }, paths: ["kind"] },
        { name: "a key in a setting", input: { kind: "button", label: `token ${["ghp", "Q".repeat(36)].join("_")}` }, paths: ["label"] },
      ],
    });
    assertContract({
      schema: triggerConfigSchema,
      read: input => verdict(readTriggerConfig(input)),
      valid: [
        ...triggers.triggers.map(one => ({ name: one.name, input: one.config })),
        { name: "a chat channel", input: { kind: "chat", app: "slack", installation: "T0", chat: "C0", binding: 4, zone: null } },
        { name: "a github trigger saved without its delivery", input: { kind: "github", repo: "acme/shop", watch: "issues", label: null, branch: null, from: "team", zone: null } },
      ],
      invalid: [
        { name: "a config from nowhere", input: { kind: "button", label: "Go", questions: ["Q"], zone: null, hook: "x" }, paths: ["payload"] },
        { name: "a kind no trigger has", input: { kind: "fax" }, paths: ["kind"] },
      ],
    });
    assertContract({ schema: leadTriggerSchema, read: input => verdict(parseContract(leadTriggerSchema, input, FLOW_ALIASES)), valid: [{ name: "another flow", input: { kind: "flow", follow: 3 } }], invalid: [{ name: "a webhook", input: { kind: "webhook" }, paths: ["kind"] }] });
  });

  it("save exactly what the pre-Zod reader saved, and read it back the same", () => {
    const definition = FLOW_TEMPLATES[0]!.definition;
    const flow = store.getFlow(store.createFlow({ repo: join(dir, "shop"), name: "Triggers", definitionJson: JSON.stringify(definition), by: "alex" }, new Date()))!;
    const source = store.createFlow({ repo: join(dir, "shop"), name: "Source", definitionJson: JSON.stringify(FLOW_TEMPLATES[2]!.definition), by: "alex" }, new Date());
    store.saveFlowScript({ repo: flow.repo, name: "triage", about: "Says what it is", body: "print('x')", language: "python", timeoutMinutes: 15, digest: "d", by: "alex" }, new Date());
    for (const one of triggers.triggers) {
      const input = one.input["kind"] === "flow" ? { ...one.input, flow: source } : one.input;
      const expected = one.input["kind"] === "flow" ? { ...(one.config as object), flow: source } : one.config;
      expect(JSON.stringify(validateTriggerConfig(structuredClone(input), { store, flow, definition, actor: "alex" })), one.name).toBe(JSON.stringify(expected));
      expect(readTriggerConfig(one.config), one.name).toEqual({ ok: true, value: one.config });
    }
  });
});

describe("propose_flow", () => {
  it("is what the lead is told, derived from the same step and trigger schemas, with limits from TEXT_LIMITS", () => {
    expect(PROPOSE_FLOW_MODEL_SCHEMA).toEqual(toModelSchema(proposeFlowInputSchema));
    expect(MATE_TOOLS.find(one => one.name === "propose_flow")!.inputSchema).toEqual(PROPOSE_FLOW_MODEL_SCHEMA);
    const properties = PROPOSE_FLOW_MODEL_SCHEMA["properties"] as Record<string, Record<string, unknown>>;
    expect(properties["steps"]).toEqual(toModelSchema(flowStepsSchema.shape.steps));
    expect(properties["settings"]).toEqual(toModelSchema(leadTriggerSchema));
    const task = ((properties["steps"]!["items"] as { oneOf: Record<string, Record<string, Record<string, unknown>>>[] }).oneOf).find(one => (one["properties"]!["kind"] as { const?: string }).const === "task")!;
    expect(task["properties"]!["instructions"]).toMatchObject({ maxLength: TEXT_LIMITS.flowInstructions });
    expect(task).toMatchObject({ additionalProperties: false, required: ["title", "kind"] });
    assertContract({
      schema: proposeFlowInputSchema,
      read: input => verdict(parseContract(proposeFlowInputSchema, input, FLOW_ALIASES)),
      valid: [
        { name: "create from steps", input: { operation: "create", repo: "r1", name: "Bugs", steps: [{ title: "Inbox", kind: "inbox" }, { title: "Go", kind: "approval", decider: "me" }] } },
        { name: "a trigger following another flow", input: { operation: "add_trigger", flow: 1, settings: { kind: "flow", follow: 2, when: "Done" } } },
        { name: "a kit", input: { operation: "kit", repo: "r1", kit: "support-desk" } },
      ],
      invalid: [
        { name: "a route's to", input: { operation: "create", repo: "r1", steps: [{ title: "Run", kind: "check", routes: [{ answer: "x", to: "y" }] }] }, paths: ["steps[0].routes[0]", "steps[0].routes[0].goesTo"] },
        { name: "an unknown argument", input: { operation: "create", stages: [] }, paths: ["payload"] },
        { name: "a webhook from chat", input: { operation: "add_trigger", settings: { kind: "webhook" } }, paths: ["settings.kind"] },
      ],
    });
    expect(lines(verdict(parseContract(proposeFlowInputSchema, { operation: "create", stages: [] }, FLOW_ALIASES)))).toEqual(["payload: unknown key 'stages' (did you mean steps?)"]);
  });

  it("is JSON-Schema-exact: no refinement, transform or default anywhere in it", () => {
    expect(() => toModelSchema(proposeFlowInputSchema)).not.toThrow();
    expect(() => toModelSchema(z.strictObject({ steps: flowStepsSchema.shape.steps.transform(steps => steps) }))).toThrow(/transform/);
  });
});

describe("docs/plans/zod-revamp.md", () => {
  it("marks wave 1 item 3 done, with what it kept and what it tightened", () => {
    const doc = readFileSync(new URL("../../docs/plans/zod-revamp.md", import.meta.url), "utf8");
    expect(doc).toMatch(/^\| 3 ✅ \| \*\*Flow definitions and step inputs\*\*/m);
    const done = doc.slice(doc.indexOf("## Done"));
    expect(done).toContain("**3. Flow definitions and step inputs**");
    expect(done).toMatch(/byte for byte/);
    expect(done).toMatch(/Tightened, on purpose/);
  });
});
