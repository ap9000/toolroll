import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { openStore } from "../store.js";
import { FlowContractError, FLOW_TEMPLATES, flowFromSteps, validateFlowDefinition, type FlowDefinition } from "../flows.js";
import { GALLERY, galleryDiagram, withSendResult } from "../flow-gallery.js";
import { STARTER_FLOWS } from "../flow-starters.js";
import { KITS } from "../kits.js";
import { parseFlowFile } from "../flow-share.js";
import { assertContract, roundTripLoss, type SampleVerdict } from "./contract-test.js";
import { FLOW_STAGE_KINDS } from "./flow.js";
import { flowCardChangeSchema, flowCardSchema } from "./flow-card.js";
import {
  cardOutputsForStore, cardOutputsFromStore, cardOutputsSchema, readCardOutputs, STAGE_HANDOFFS, stageFieldsOf, stageHandoffOf, stageHandoffSchema,
  stageReferenceProblems, withStageHandoff,
} from "./stage-output.js";

type Recorded = { name: string; source: string; raw: string; reads: Record<string, string> };
const recorded = (JSON.parse(readFileSync(new URL("../../test/fixtures/stages/card-outputs.json", import.meta.url), "utf8")) as { samples: Recorded[] }).samples;
const verdict = (parsed: { ok: true } | { ok: false; issues: { line: string }[] }): SampleVerdict => parsed.ok ? { ok: true } : { ok: false, lines: parsed.issues.map(issue => issue.line) };
const json = (raw: string): unknown => { try { return JSON.parse(raw); } catch { return undefined; } };

describe("what a card keeps of what its zones handed on", () => {
  it("holds: the JSON Schema round trip loses nothing, saved rows of every age read, and a bad current one is refused by path", () => {
    assertContract({
      schema: cardOutputsSchema,
      read: input => verdict(readCardOutputs(input)),
      valid: [
        ...recorded.filter(one => json(one.raw) !== undefined).map(one => ({ name: `saved before versions: ${one.name}`, input: json(one.raw) })),
        { name: "version 1", input: { version: 1, outputs: { research: "Summary.", "research.items": "1. One" }, attached: {} } },
        { name: "version 1, an output attached whole", input: { version: 1, outputs: { check: "This is 15,000 characters…" }, attached: { check: "x".repeat(15_000) } } },
      ],
      invalid: [
        { name: "words that aren't text", input: { version: 1, outputs: { build: 3 }, attached: {} }, paths: ["outputs.build"] },
        { name: "no attachments", input: { version: 1, outputs: {} }, paths: ["attached"] },
        { name: "a key it doesn't know", input: { version: 1, outputs: {}, attached: {}, stages: {} }, paths: ["payload"] },
        { name: "a newer Toolroll's", input: { version: 2, outputs: {}, attached: {} }, paths: ["version"] },
      ],
    });
    expect(readCardOutputs({ version: 2, outputs: {}, attached: {} })).toMatchObject({ ok: false, issues: [{ line: "version: made by a newer Toolroll (version 2; this one reads up to 1)" }] });
  });

  it("reads every saved row exactly as 0.9.36 did: the same words, under the same names, in the same order", () => {
    for (const one of recorded) {
      const read = cardOutputsFromStore(one.raw);
      expect(read.outputs, one.name).toEqual(one.reads);
      expect(Object.keys(read.outputs), one.name).toEqual(Object.keys(one.reads));
      expect(read.attached).toEqual({});
    }
    // A zone called `version` was words, never a version.
    expect(cardOutputsFromStore(JSON.stringify({ version: "Bumped to 1.2.3." })).outputs).toEqual({ version: "Bumped to 1.2.3." });
  });

  it("the store reads saved rows as before, writes outputs only when they change, versioned, and never over a newer Toolroll's", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "so-stage-output-")));
    const store = openStore(join(dir, "state.db"));
    const raw = new DatabaseSync(join(dir, "state.db"));
    try {
      const now = new Date("2026-10-05T09:00:00.000Z");
      const flow = store.createFlow({ repo: "/projects/alpha", name: "Recorded", definitionJson: JSON.stringify({ version: 1, start: "inbox", stages: [] }), by: "alex" }, now);
      const card = store.addFlowCard({ flow, title: "Recorded", description: null, stage: "inbox", by: "alex" }, now);
      const saved = () => String(raw.prepare("SELECT outputs_json FROM flow_card WHERE id = ?").get(card)!["outputs_json"]);
      const put = (value: string) => raw.prepare("UPDATE flow_card SET outputs_json = ? WHERE id = ?").run(value, card);
      for (const one of recorded) {
        put(one.raw);
        expect(store.getFlowCard(card)!.outputs, one.name).toEqual(one.reads);
        store.updateFlowCard(card, { waiting: "Working on it" }, now);
        expect(saved(), one.name).toBe(one.raw);
      }
      put(recorded.find(one => one.name === "research with its items and report")!.raw);
      store.updateFlowCard(card, { outputs: withStageHandoff(store.getFlowCard(card)!.outputs, "build", { text: "Result ready on task t1." }) }, now);
      expect(JSON.parse(saved())).toMatchObject({ version: 1, outputs: { research: expect.any(String), "research.items": expect.any(String), build: "Result ready on task t1." }, attached: {} });
      const newer = JSON.stringify({ version: 2, stages: { build: { text: "From the future." } } });
      put(newer);
      expect(store.getFlowCard(card)!.outputs).toEqual({});
      store.updateFlowCard(card, { outputs: { build: "Clobbered?" }, waiting: null }, now);
      expect(saved()).toBe(newer);
    } finally {
      raw.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps an attachment only beside its output", () => {
    expect(JSON.parse(cardOutputsForStore({ check: "pointer" }, { check: "whole", gone: "stale" }))).toEqual({ version: 1, outputs: { check: "pointer" }, attached: { check: "whole" } });
  });
});

describe("one zone's handoff", () => {
  it("holds per kind: each kind's schema survives the round trip, and only research hands on items and its report", () => {
    expect(roundTripLoss(stageHandoffSchema)).toEqual([]);
    for (const kind of FLOW_STAGE_KINDS) {
      const schema = STAGE_HANDOFFS[kind];
      if (schema !== null) expect(roundTripLoss(schema), kind).toEqual([]);
    }
    expect(FLOW_STAGE_KINDS.filter(kind => STAGE_HANDOFFS[kind] === null)).toEqual(["inbox", "approval", "notify", "choose", "done"]);
    expect(stageFieldsOf("report")).toEqual(["items", "report"]);
    expect(stageFieldsOf("draft")).toEqual([]);
    expect(stageHandoffSchema.safeParse({ text: "x", extra: "y" }).success).toBe(false);
  });

  it("is read from and written into the card's flat outputs, leaving nothing stale", () => {
    const outputs = { research: "Old.", "research.items": "1. Old", "research.report": "# Old", build: "Result ready." };
    expect(stageHandoffOf(outputs, "research")).toEqual({ text: "Old.", items: "1. Old", report: "# Old" });
    expect(stageHandoffOf(outputs, "missing")).toEqual({ text: "" });
    expect(withStageHandoff(outputs, "research", { text: "New.", items: "1. New" })).toEqual({ research: "New.", "research.items": "1. New", build: "Result ready." });
  });

  it("the card's state and its changes are the schema's", () => {
    expect(roundTripLoss(flowCardSchema)).toEqual([]);
    expect(roundTripLoss(flowCardChangeSchema)).toEqual([]);
    expect(flowCardChangeSchema.safeParse({ outputs: { a: "b" }, attached: {}, state: "done" }).success).toBe(true);
    expect(flowCardChangeSchema.safeParse({ state: "active" }).success).toBe(false);
  });
});

describe("template references, checked when a flow is saved", () => {
  const drawing = (instructions: string, message = "Done: {{card.title}}") => ({ version: 1, start: "research", stages: [
    { id: "research", title: "Research", kind: "report", instructions: "Look into {{card.title}}", next: "tell" },
    { id: "tell", title: "Tell the team", kind: "notify", message, next: "build" },
    { id: "build", title: "Build", kind: "task", instructions, next: "done" },
    { id: "done", title: "Done", kind: "done" },
  ] });
  const lines = (definition: FlowDefinition, previous: FlowDefinition | null = null) => stageReferenceProblems(definition, previous).map(one => one.line);

  it("names the path and what the zone hands on instead", () => {
    const definition = validateFlowDefinition(drawing("Use {{stage.research.items}} and {{stage.research.unknown}} and {{ stage.reserch }} and {{stage.tell}}"));
    expect(lines(definition)).toEqual([
      "stages[2].instructions: stage.research.unknown is not available (Research hands on {{stage.research}}, {{stage.research.items}} and {{stage.research.report}})",
      "stages[2].instructions: stage.reserch is not available: there's no zone called reserch",
      "stages[2].instructions: stage.tell is not available: Tell the team hands nothing on",
    ]);
    expect(lines(validateFlowDefinition(drawing("Build it", "Built: {{stage.build.items}}")))).toEqual(["stages[1].message: stage.build.items is not available (Build hands on {{stage.build}})"]);
  });

  it("never refuses a reference the saved flow already had, and is never applied when a saved flow is read", () => {
    const saved = validateFlowDefinition(drawing("Use {{stage.research.unknown}}"), { stored: true });
    expect(lines(saved, saved)).toEqual([]);
    const edited = validateFlowDefinition(drawing("Use {{stage.research.unknown}} and {{stage.research.report}}"));
    expect(lines(edited, saved)).toEqual([]);
    expect(lines(validateFlowDefinition(drawing("Use {{stage.research.unknown}} and {{stage.build.report}}")), saved)).toEqual([
      "stages[2].instructions: stage.build.report is not available (Build hands on {{stage.build}})",
    ]);
  });

  it("refuses a step list's new reference in the step's own words, keeping the ones a flow had", () => {
    const steps = (ask: string) => [{ id: "research", title: "Research", kind: "report", instructions: "Look into {{card.title}}" }, { title: "Write", kind: "draft", instructions: ask }];
    expect(() => flowFromSteps(steps("Reply from {{stage.research.summary}}"), null)).toThrow(FlowContractError);
    try { flowFromSteps(steps("Reply from {{stage.research.summary}}"), null); } catch (error) {
      expect((error as FlowContractError).lines).toEqual(["steps[1].instructions: stage.research.summary is not available (Research hands on {{stage.research}}, {{stage.research.items}} and {{stage.research.report}})"]);
    }
    const before = validateFlowDefinition({ version: 1, start: "research", stages: [
      { id: "research", title: "Research", kind: "report", instructions: "Look into {{card.title}}", next: "write" },
      { id: "write", title: "Write", kind: "draft", instructions: "Reply from {{stage.research.summary}}", next: null },
    ] }, { stored: true });
    expect(flowFromSteps([{ id: "research" }, { id: "write", instructions: "Reply from {{stage.research.summary}}, briefly" }], before).stages[1]!.instructions).toBe("Reply from {{stage.research.summary}}, briefly");
  });

  it("passes every flow Toolroll ships and every recorded saved flow and flow file as it is", () => {
    const all: [string, () => FlowDefinition][] = [
      ...GALLERY.flatMap(template => [[`gallery ${template.id}`, () => galleryDiagram(template)], [`gallery ${template.id} + send`, () => withSendResult(galleryDiagram(template))],
        ...(template.ownSteps === undefined ? [] : [[`gallery ${template.id} (own)`, () => flowFromSteps(template.ownSteps!, null)]])] as [string, () => FlowDefinition][]),
      ...FLOW_TEMPLATES.map(template => [`template ${template.id}`, () => template.definition] as [string, () => FlowDefinition]),
      ...STARTER_FLOWS.flatMap(starter => [[`starter ${starter.id}`, () => flowFromSteps(starter.steps, null)],
        ...(starter.ownSteps === undefined ? [] : [[`starter ${starter.id} (own)`, () => flowFromSteps(starter.ownSteps!, null)]])] as [string, () => FlowDefinition][]),
      ...KITS.map(kit => [`kit ${kit.id}`, () => flowFromSteps(kit.steps, null)] as [string, () => FlowDefinition]),
    ];
    const stored = JSON.parse(readFileSync(new URL("../../test/fixtures/flows/stored-definitions.json", import.meta.url), "utf8")) as { valid: { name: string; input: unknown }[] };
    const files = JSON.parse(readFileSync(new URL("../../test/fixtures/flows/flow-files.json", import.meta.url), "utf8")) as { files: { name: string; json: string; imported: string | null; refused: string | null }[] };
    for (const one of stored.valid) all.push([`saved ${one.name}`, () => validateFlowDefinition(one.input, { stored: true })]);
    for (const one of files.files) if (one.refused === null && one.imported !== null) all.push([`file ${one.name}`, () => { parseFlowFile(one.json); return JSON.parse(one.imported!) as FlowDefinition; }]);
    expect(all.length).toBeGreaterThan(150);
    for (const [name, make] of all) {
      const definition = make();
      expect(lines(definition), name).toEqual([]);
    }
  });
});

describe("the plan", () => {
  it("marks item 8 done, with its note", () => {
    const plan = readFileSync(new URL("../../docs/plans/zod-revamp.md", import.meta.url), "utf8");
    expect(plan).toMatch(/^\| 8 ✅ \| \*\*Flow stage outputs and card state\*\*/m);
    expect(plan.slice(plan.indexOf("## Done"))).toMatch(/^- \*\*8\. Flow stage outputs and card state\*\* \(\d{4}-\d{2}-\d{2}\)/m);
  });
});
