import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TEXT_LIMITS } from "../text-limits.js";
import { contractError, limited, parseContract, readVersioned, toModelSchema, versioned } from "./contract.js";
import { assertContract, contractFailures, roundTripLoss, type SampleVerdict } from "./contract-test.js";

const flow = versioned(2, {
  name: limited("name", "note").min(1),
  steps: z.array(z.strictObject({ id: z.string(), routes: z.array(z.strictObject({ goesTo: z.string(), ifFails: z.string().optional() })) })).max(3),
});
const read = (input: unknown): SampleVerdict => {
  const result = readVersioned(flow, input, { 1: ({ stages, ...body }) => ({ ...body, version: 2, steps: stages ?? [] }) });
  return result.ok ? { ok: true } : { ok: false, lines: result.issues.map(issue => issue.line) };
};

describe("limited", () => {
  it("takes its bound from TEXT_LIMITS and tells the model the rule", () => {
    const json = toModelSchema(limited("goal", "goal"));
    expect(json["maxLength"]).toBe(TEXT_LIMITS.goal);
    expect(String(json["description"])).toContain("goal: at most 8,000 characters");
    expect(limited("goal", "goal").safeParse("g".repeat(TEXT_LIMITS.goal)).success).toBe(true);
    const over = limited("goal", "goal").safeParse("g".repeat(TEXT_LIMITS.goal + 1));
    expect(over.success ? [] : contractError(over.error)).toEqual(["payload: over 8,000 characters"]);
    expect(String(toModelSchema(limited("id", "acceptanceIdBytes"))["description"])).toContain("at most 40 bytes");
  });
});

describe("versioned", () => {
  it("accepts the current version, upgrades a known older one and refuses a newer one plainly", () => {
    expect(read({ version: 2, name: "n", steps: [] })).toEqual({ ok: true });
    expect(read({ version: 1, name: "n", stages: [{ id: "a", routes: [] }] })).toEqual({ ok: true });
    expect(read({ version: 3, name: "n", steps: [] })).toEqual({ ok: false, lines: ["version: made by a newer Toolroll (version 3; this one reads up to 2)"] });
    expect(read({ name: "n", steps: [] })).toEqual({ ok: false, lines: ["version: unknown version 0 (this Toolroll reads 2 and 1)"] });
    expect(read([])).toEqual({ ok: false, lines: ["payload: must be an object (got an array)"] });
  });
});

describe("contractError", () => {
  it("calls integers integers and distinguishes an optional null from a missing required value", () => {
    const schema = z.strictObject({ run: z.int(), offset: z.int().optional(), nested: z.array(z.strictObject({ note: z.string().optional() })) });
    const result = parseContract(schema, { run: 1.5, offset: null, nested: [{ note: null }] });
    expect(result.ok ? [] : result.issues.map(issue => issue.line)).toEqual([
      "run: must be an integer (got a number)",
      "offset: must be a number (got null)",
      "nested[0].note: must be a string (got null)",
    ]);
    const missing = parseContract(schema, { nested: [] });
    expect(missing.ok ? [] : missing.issues.map(issue => issue.line)).toEqual(["run: required"]);
  });

  it("names the path of every problem", () => {
    const result = parseContract(flow, { version: 2, name: "", steps: [{ id: "a", routes: [{ to: "b" }] }, { id: 1, routes: [] }], extra: true });
    expect(result.ok ? [] : result.issues.map(issue => issue.line)).toEqual([
      "name: must not be empty",
      "steps[0].routes[0].goesTo: required",
      "steps[0].routes[0]: unknown key 'to'",
      "steps[1].id: must be a string (got a number)",
      "payload: unknown key 'extra'",
    ]);
    const plain = flow.safeParse({ version: 2, steps: [] });
    expect(plain.success ? [] : contractError(plain.error)).toEqual(["name: required"]);
  });
});

describe("unknown keys and unions", () => {
  const step = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("task"), title: z.string(), ifFails: z.string().optional(), routes: z.array(z.strictObject({ answer: z.string(), goesTo: z.string() })).optional() }),
    z.strictObject({ kind: z.literal("sort"), title: z.string(), ifNotSure: z.string().optional() }),
  ]);
  const steps = z.strictObject({ steps: z.array(step) });
  const aliases = { onFail: ["ifFails", "ifNotSure"], to: ["goesTo"] };
  const read = (input: unknown, options = {}) => { const result = parseContract(steps, input, options); return result.ok ? [] : result.issues.map(issue => issue.line); };

  it("suggests the key an unknown one meant: an alias allowed at that place, else a near spelling", () => {
    expect(read({ steps: [{ kind: "task", title: "t", onFail: "x", routes: [{ answer: "a", to: "b" }] }, { kind: "sort", title: "s", onFail: "x" }] }, { aliases })).toEqual([
      "steps[0].routes[0].goesTo: required",
      "steps[0].routes[0]: unknown key 'to' (did you mean goesTo?)",
      "steps[0]: unknown key 'onFail' (did you mean ifFails?)",
      "steps[1]: unknown key 'onFail' (did you mean ifNotSure?)",
    ]);
    expect(read({ steps: [{ kind: "task", title: "t", iffails: "x", titl: "y" }] })).toEqual(["steps[0]: unknown key 'iffails' (did you mean ifFails?)", "steps[0]: unknown key 'titl' (did you mean title?)"]);
    expect(read({ steps: [{ kind: "task", title: "t", colour: "red" }] })).toEqual(["steps[0]: unknown key 'colour'"]);
  });

  it("names a discriminated union's choices, and reads a null or missing discriminator or value as required", () => {
    expect(read({ steps: [{ kind: "teleport", title: "t" }, { title: "t" }, { kind: "task", title: null }] })).toEqual([
      "steps[0].kind: must be one of \"task\", \"sort\"",
      "steps[1].kind: required",
      "steps[2].title: required",
    ]);
  });
});

describe("toModelSchema", () => {
  it("returns the JSON Schema without its dialect line", () => {
    const json = toModelSchema(flow);
    expect(json["$schema"]).toBeUndefined();
    expect(json).toMatchObject({ type: "object", additionalProperties: false, required: ["version", "name", "steps"] });
  });

  it.each([
    ["refine", z.strictObject({ a: z.array(z.string().refine(value => value !== "")) }), "a[] uses refine or superRefine"],
    ["superRefine", z.strictObject({ a: z.string().nullable().superRefine(() => undefined) }), "a uses refine or superRefine"],
    ["transform", z.strictObject({ a: z.union([z.number(), z.string().transform(value => value.length)]) }), "a|1 uses transform"],
    ["preprocess", z.strictObject({ a: z.preprocess(value => value, z.string()) }), "a uses preprocess"],
    ["a rewriting check", z.strictObject({ a: z.string().trim() }), "a uses a overwrite check"],
    ["default", z.strictObject({ a: z.string().default("x") }), "a uses a default node"],
    ["lazy", z.strictObject({ a: z.lazy(() => z.string().refine(() => true)) }), "a uses refine"],
  ])("refuses %s anywhere in the schema, by its path", (_name, schema, message) => {
    expect(() => toModelSchema(schema)).toThrow(message);
  });
});

describe("the contract-test harness", () => {
  it("passes a contract whose samples and round trip hold", () => {
    expect(() => assertContract({
      schema: flow,
      read,
      valid: [{ name: "current", input: { version: 2, name: "n", steps: [{ id: "a", routes: [{ goesTo: "b" }] }] } }, { name: "saved by version 1", input: { version: 1, name: "n", stages: [] } }],
      invalid: [{ name: "old field name", input: { version: 2, name: "n", steps: [{ id: "a", routes: [{ to: "b" }] }] }, paths: ["steps[0].routes[0].goesTo", "steps[0].routes[0]"] }],
    })).not.toThrow();
  });

  it("reports a valid sample refused, an invalid one accepted, and a path the error does not name", () => {
    expect(contractFailures({
      read,
      valid: [{ name: "too new", input: { version: 9, name: "n", steps: [] } }],
      invalid: [
        { name: "fine", input: { version: 2, name: "n", steps: [] }, paths: ["name"] },
        { name: "wrong path", input: { version: 2, name: "", steps: [] }, paths: ["steps"] },
      ],
    })).toEqual([
      "too new: refused — version: made by a newer Toolroll (version 9; this one reads up to 2)",
      "fine: accepted, expected a refusal naming name",
      "wrong path: no line names steps — name: must not be empty",
    ]);
  });

  it("finds no keyword lost in the round trip for a schema JSON Schema can state", () => {
    expect(roundTripLoss(flow)).toEqual([]);
  });
});
