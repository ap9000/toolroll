/**
 * Every lead tool and MCP gateway tool contract (docs/plans/zod-revamp.md, item 5), one table: each input schema's
 * JSON Schema survives the round trip and every recorded call is accepted. Historical tools also compare against the
 * unchanged 0.9.36 schemas, with explicit renames and intended differences. Additions need current call coverage.
 * Lead readers also preserve the older handlers' loose calls; malformed calls are refused by path.
 * Each output schema gets the same: a well-formed result is accepted and a malformed one refused by path. The registries
 * are checked against what the model and tools/list are shown, so a tool added or dropped can't escape the table.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { mintCoordinator } from "../coordinator.js";
import { LEAD_TOOL_SCHEMAS, LEAD_TOOLS } from "../lead-tools.js";
import { MODERN, serveMcp } from "../mcp.js";
import { openStore } from "../store.js";
import { parseContract, toModelSchema } from "./contract.js";
import { assertContract, type InvalidSample, type SampleVerdict } from "./contract-test.js";
import { GATEWAY_TOOL_INPUTS, GATEWAY_TOOL_OUTPUTS } from "./gateway-tools.js";
import { LEAD_TOOL_INPUTS, LEAD_TOOL_OPTIONS, LEAD_TOOL_OUTPUTS, reportToolOutput } from "./lead-tools.js";

type Json = Record<string, unknown>;
type Surface = "lead" | "gateway";
const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../../test/fixtures/tools/${name}`, import.meta.url), "utf8")) as T;
const OLD_BYTES = readFileSync(new URL("../../test/fixtures/tools/schemas-0.9.36.json", import.meta.url));
const OLD = JSON.parse(OLD_BYTES.toString("utf8")) as { lead: Record<string, Json | null>; gateway: Record<string, Json>; leadDescriptions: Record<string, string> };
const CALLS = fixture<{ lead: Record<string, Json[]>; gateway: Record<string, Json[]> }>("calls.json");
const LOOSE = fixture<{ calls: Record<string, Json[]> }>("loose-lead-calls-0.9.36.json").calls;
const FALLBACK_FIELDS: Record<string, string[]> = { list_tasks: ["limit"], get_task_conversation: ["limit"], get_flow_insights: ["days"], get_person: ["id", "name"] };

const INPUTS: Record<Surface, Record<string, z.ZodType>> = { lead: LEAD_TOOL_INPUTS, gateway: GATEWAY_TOOL_INPUTS };
const OUTPUTS: Record<Surface, Record<string, z.ZodType>> = { lead: LEAD_TOOL_OUTPUTS, gateway: GATEWAY_TOOL_OUTPUTS };

/** Retire historical names explicitly; never rewrite the baseline to make them current. D5 keeps their behavior. */
const RENAMED: Record<Surface, Record<string, { from: string; fields: Record<string, string>; why: string }>> = {
  lead: {
    get_subagents: { from: "get_teammates", fields: { subagent: "teammate" }, why: "D5: teammates are the lead's named subagents" },
    propose_subagent: { from: "propose_teammate", fields: { subagent: "teammate" }, why: "D5: retain each subagent's personality, rules and operations" },
  },
  gateway: {},
};
// No historical tools are removed without a replacement today. Future removals must record their decision here.
const REMOVED: Record<Surface, Record<string, string>> = { lead: {}, gateway: {} };
const DESCRIPTION_CHANGES: Record<string, string> = {
  get_flows: "D5: describe delegation through the lead and named subagents",
  propose_flow: "D5: teammate tools, steps and fields are named subagent",
  get_person: "D5: the people index calls teammates subagents",
  get_subagents: "D5: describe the renamed tool and field",
  propose_subagent: "D5: describe the renamed tool and the new ask operation",
};
const historicalName = (surface: Surface, tool: string) => RENAMED[surface][tool]?.from ?? tool;
const historicalCall = (surface: Surface, tool: string, call: unknown): unknown => {
  if (!call || typeof call !== "object" || Array.isArray(call)) return call;
  const fields = RENAMED[surface][tool]?.fields ?? {};
  return Object.fromEntries(Object.entries(call).map(([key, value]) => [fields[key] ?? key, value]));
};

/**
 * Calls whose verdict changed on purpose, each with why (the plan's Done entry says so too). Every other recorded and
 * malformed call is described the same by the 0.9.36 schema and the derived model schema. Those advertised schemas
 * were not the lead's runtime validator: the separate loose samples exercise the handlers' compatibility behavior.
 */
const CHANGED: { surface: Surface; tool: string; call: Json; before: boolean; why: string }[] = [
  { surface: "lead", tool: "propose_task", call: { repo: "r1", title: "t", goal: "g", not: null, acceptance: [{ id: "c1", statement: "s", evidence: ["check"] }] }, before: false,
    why: "the handler always read null exclusions as none; the schema now says so" },
  { surface: "lead", tool: "propose_review", call: { run: 7, operation: "revise", note: null, path: null, line: null, saved_notes: [1] }, before: false,
    why: "the handler always read a null note, path and line as left out; the schema now says so" },
  { surface: "lead", tool: "propose_task", call: { repo: "r1", title: "t", goal: "g", acceptance: [{ id: "", statement: "", evidence: ["check"] }] }, before: true,
    why: "the plan's acceptance criterion (an empty id or statement was refused after parsing anyway)" },
  { surface: "lead", tool: "propose_subagent", call: { operation: "ask", subagent: 2, text: "Draft the reply to Sam about order 1043." }, before: false,
    why: "D5 adds named delegation; the historical teammate tool did not have ask" },
];

const verdict = (schema: z.ZodType, input: unknown): SampleVerdict => {
  const read = parseContract(schema, input);
  return read.ok ? { ok: true } : { ok: false, lines: read.issues.map(issue => issue.line) };
};

/** A value of the wrong JSON type for `value`. */
const wrongType = (value: unknown): unknown => (typeof value === "string" ? 42 : "x");

/** Malformed calls built from the recorded ones: each with the exact path its refusal must name. */
function malformed(schema: z.ZodType, calls: readonly Json[]): InvalidSample[] {
  const json = toModelSchema(schema) as { properties?: Record<string, Json>; required?: string[] };
  const fullest = [...calls].sort((a, b) => Object.keys(b).length - Object.keys(a).length)[0]!;
  const out: InvalidSample[] = [
    { name: "not an object", input: [fullest], paths: ["payload"] },
    { name: "an unknown key", input: { ...fullest, zz_unknown: 1 }, paths: ["payload"] },
  ];
  for (const key of json.required ?? []) {
    const { [key]: _gone, ...rest } = fullest;
    out.push({ name: `missing ${key}`, input: rest, paths: [key] });
  }
  for (const [key, value] of Object.entries(fullest)) {
    out.push({ name: `${key} of the wrong type`, input: { ...fullest, [key]: wrongType(value) }, paths: [key] });
    if (Array.isArray(value) && value.length > 0) out.push({ name: `${key} with a bad item`, input: { ...fullest, [key]: [wrongType(value[0]), ...value.slice(1)] }, paths: [`${key}[0]`] });
    if (Array.isArray(value) && typeof value[0] === "object" && value[0] !== null) {
      out.push({ name: `${key}[0] with an unknown key`, input: { ...fullest, [key]: [{ ...value[0], zz_unknown: 1 }, ...value.slice(1)] }, paths: [`${key}[0]`] });
    }
  }
  return out;
}

/** A minimal well-formed value for a JSON Schema: required keys only, the first choice of a union or enum. */
function sampleOf(schema: Json): unknown {
  if ("const" in schema) return schema["const"];
  if (Array.isArray(schema["enum"])) return schema["enum"][0];
  if (Array.isArray(schema["anyOf"])) return sampleOf(schema["anyOf"][0] as Json);
  switch (schema["type"]) {
    case "object": {
      const properties = (schema["properties"] ?? {}) as Record<string, Json>;
      return Object.fromEntries(((schema["required"] ?? []) as string[]).map(key => [key, sampleOf(properties[key]!)]));
    }
    case "array": return [];
    case "string": return "x";
    case "integer": case "number": return 1;
    case "boolean": return true;
    case "null": return null;
    default: return "anything";
  }
}

const NAMES: Record<Surface, string[]> = { lead: Object.keys(LEAD_TOOL_INPUTS), gateway: Object.keys(GATEWAY_TOOL_INPUTS) };
const TABLE = (["lead", "gateway"] as const).flatMap(surface => NAMES[surface].map(tool => ({ surface, tool })));

/** What the gateway's tools/list says, read through the server itself. */
function gatewayToolsList(): { name: string; inputSchema: Json }[] {
  const store = openStore(":memory:");
  try {
    const made = mintCoordinator(store, { name: "contract-bot", repos: ["/repo/demo"], by: "alex", now: new Date("2026-10-05T12:00:00Z") });
    if (!made.ok) throw new Error("mint failed");
    let onLine: (line: string) => void = () => undefined;
    const out: string[] = [];
    serveMcp(store, made.token, { onLine: handler => { onLine = handler; }, onEof: () => undefined, write: line => out.push(line), log: () => undefined, exit: () => undefined });
    onLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientCapabilities": {} } } }));
    return (JSON.parse(out[0]!) as { result: { tools: { name: string; inputSchema: Json }[] } }).result.tools;
  } finally {
    store.close();
  }
}

describe("the lead and gateway tool registries", () => {
  it("keeps the historical schema fixture byte-for-byte", () => {
    expect(createHash("sha256").update(OLD_BYTES).digest("hex")).toBe("e6ada37434f4b092beeba403e897b7b3755632ac9bad92edaa0868b6084ce902");
  });

  it("cover every tool the model and tools/list are shown, each with an input and an output schema", () => {
    expect(LEAD_TOOL_SCHEMAS.map(one => one.name)).toEqual(NAMES.lead);
    expect(Object.keys(LEAD_TOOL_OUTPUTS)).toEqual(NAMES.lead);
    const listed = gatewayToolsList();
    expect(listed.map(one => one.name)).toEqual(NAMES.gateway);
    expect(Object.keys(GATEWAY_TOOL_OUTPUTS)).toEqual(NAMES.gateway);
    // Current calls cover every current tool, including additions that have no historical schema.
    for (const surface of ["lead", "gateway"] as const) {
      expect(Object.keys(CALLS[surface])).toEqual(NAMES[surface]);
    }
  });

  it("accounts for every historical tool under its original name, an explicit rename or a documented removal", () => {
    for (const surface of ["lead", "gateway"] as const) {
      const renamed = Object.entries(RENAMED[surface]);
      for (const [current, change] of renamed) {
        expect(OLD[surface], change.why).toHaveProperty(change.from);
        expect(NAMES[surface], change.why).toContain(current);
        expect(NAMES[surface], change.why).not.toContain(change.from);
        expect(REMOVED[surface]).not.toHaveProperty(change.from);
      }
      expect(new Set(renamed.map(([, change]) => change.from)).size).toBe(renamed.length);
      for (const [removed, why] of Object.entries(REMOVED[surface])) {
        expect(why.trim().length).toBeGreaterThan(0);
        expect(OLD[surface]).toHaveProperty(removed);
        expect(NAMES[surface]).not.toContain(removed);
      }
      for (const old of Object.keys(OLD[surface])) {
        if (REMOVED[surface][old]) continue;
        expect(NAMES[surface], `${surface}: historical ${old}`).toContain(renamed.find(([, change]) => change.from === old)?.[0] ?? old);
      }
    }
  });

  it("shows the derived schemas and preserves historical descriptions except for documented changes", () => {
    for (const tool of LEAD_TOOL_SCHEMAS) expect(tool.inputSchema, tool.name).toEqual(toModelSchema(LEAD_TOOL_INPUTS[tool.name as keyof typeof LEAD_TOOL_INPUTS]));
    for (const tool of LEAD_TOOL_SCHEMAS) {
      expect(tool.description).toBe(LEAD_TOOLS.find(one => one.name === tool.name)!.description);
      const old = OLD.leadDescriptions[historicalName("lead", tool.name)];
      if (old !== undefined && !DESCRIPTION_CHANGES[tool.name]) expect(tool.description, tool.name).toBe(old);
    }
    for (const [tool, why] of Object.entries(DESCRIPTION_CHANGES)) {
      expect(NAMES.lead, why).toContain(tool);
      expect(OLD.leadDescriptions, why).toHaveProperty(historicalName("lead", tool));
      expect(LEAD_TOOLS.find(one => one.name === tool)!.description, why).not.toBe(OLD.leadDescriptions[historicalName("lead", tool)]);
    }
    for (const tool of gatewayToolsList()) expect(tool.inputSchema, tool.name).toEqual(toModelSchema(GATEWAY_TOOL_INPUTS[tool.name as keyof typeof GATEWAY_TOOL_INPUTS]));
  });
});

describe.each(TABLE)("$surface tool $tool", ({ surface, tool }) => {
  const input = INPUTS[surface][tool]!;
  const output = OUTPUTS[surface][tool]!;
  const calls = CALLS[surface][tool]!;
  const read = (value: unknown): SampleVerdict => {
    if (surface === "gateway") return verdict(input, value);
    const parsed = LEAD_TOOLS.find(one => one.name === tool)!.read({} as never, value as Json);
    return parsed.ok ? { ok: true } : { ok: false, lines: parsed.issues.map(issue => issue.line) };
  };

  it("input: round trip, recorded calls accepted, malformed calls refused by path", () => {
    expect(calls.length).toBeGreaterThan(0);
    const invalid = malformed(input, calls);
    const valid = calls.map((call, index) => ({ name: `recorded call ${index + 1}`, input: call }));
    // The advertised contract stays strict on both surfaces.
    assertContract({ schema: input, read: value => verdict(input, value), valid, invalid });
    // propose_action passes unknown keys to the action's own per-operation check (as 0.9.36 did); see the handler test.
    const passesKeys = surface === "lead" && tool === "propose_action";
    const stripsKeys = surface === "lead" && tool !== "propose_flow" && !passesKeys;
    const runtimeInvalid = passesKeys ? invalid.filter(sample => sample.name !== "an unknown key") : !stripsKeys ? invalid : invalid.filter(sample =>
      sample.name !== "an unknown key" && !sample.paths.some(path => FALLBACK_FIELDS[tool]?.includes(path)));
    const loose = !stripsKeys ? [] : [
      ...calls.map((call, index) => ({ name: `recorded call ${index + 1} with an ignored key`, input: { ...call, zz_unknown: 1 } })),
      ...(LOOSE[tool] ?? []).map((call, index) => ({ name: `0.9.36 loose call ${index + 1}`, input: call })),
    ];
    assertContract({ schema: input, read, valid: [...valid, ...loose], invalid: runtimeInvalid });
    if (stripsKeys) {
      for (const call of calls) {
        const reader = LEAD_TOOLS.find(one => one.name === tool)!.read;
        expect(reader({} as never, { ...call, zz_unknown: 1 })).toEqual(reader({} as never, call));
      }
      for (const call of LOOSE[tool] ?? []) expect(input.safeParse(call).success).toBe(false);
    }
    // Compare advertised schemas; actual loose-call behavior is covered above and in the handler tests.
    const before = OLD[surface][historicalName(surface, tool)];
    if (before === null || before === undefined) return;
    const old = z.fromJSONSchema(before as never) as z.ZodType;
    const oldAccepts = (call: unknown) => old.safeParse(historicalCall(surface, tool, call)).success;
    for (const call of calls) {
      const change = CHANGED.find(one => one.surface === surface && one.tool === tool && isDeepStrictEqual(one.call, call));
      expect(oldAccepts(call), change?.why ?? `0.9.36 accepted ${JSON.stringify(call)}`).toBe(change?.before ?? true);
    }
    for (const sample of invalid) {
      if (Array.isArray(sample.input)) continue; // the gateway refused a non-object root before any schema; the lead never got one
      expect(oldAccepts(sample.input), `0.9.36 refused ${sample.name}`).toBe(false);
    }
    for (const change of CHANGED.filter(one => one.surface === surface && one.tool === tool)) {
      expect(oldAccepts(change.call), change.why).toBe(change.before);
      expect(read(change.call).ok, change.why).toBe(!change.before);
    }
  });

  it("output: a well-formed result is accepted, a malformed one refused by path", () => {
    const json = toModelSchema(output);
    const valid = sampleOf(json);
    const required = ((json["required"] ?? []) as string[])[0];
    const invalid: InvalidSample[] = [{ name: "not an object", input: "x", paths: ["payload"] }];
    if (required !== undefined) {
      const { [required]: _gone, ...rest } = valid as Json;
      invalid.push({ name: `missing ${required}`, input: rest, paths: [required] });
    }
    assertContract({ schema: output, read: value => verdict(output, value), valid: [{ name: "a minimal result", input: valid }], invalid });
  });
});

describe("a call's refusal", () => {
  it("names every invalid field at once, ignores extra lead keys, and keeps nested flow validation", () => {
    const lead = (tool: string, call: Json) => {
      const read = LEAD_TOOLS.find(one => one.name === tool)!.read({} as never, call);
      return read.ok ? [] : read.issues.map(issue => issue.line);
    };
    expect(lead("propose_task", { repo: "r1", title: "t", goal: "g".repeat(8_001), acceptance: [{ id: "c1", statement: "s", evidence: [] }], planing: "auto" })).toEqual([
      "goal: over 8,000 characters (it is 8,001): shorten it and call again",
      "acceptance[0].evidence: at least 1 item",
    ]);
    expect(lead("propose_agents", { task: "t-42", agent: { provider: "claude" } })).toEqual(["agent.model: required"]);
    expect(LEAD_TOOLS.find(one => one.name === "propose_agents")!.read({} as never, {
      task: "t-42", role: "builder", agent: { provider: "claude", model: "opus", zz_unknown: 1 },
    })).toEqual({ ok: true, value: { task: "t-42", role: "builder", agent: { provider: "claude", model: "opus" } } });
    expect(LEAD_TOOLS.find(one => one.name === "propose_action")!.read({} as never, { operation: "knowledge_instructions", repo: "r1", instructions: "x", password: "bad" }))
      .toEqual({ ok: true, value: { operation: "knowledge_instructions", repo: "r1", instructions: "x", password: "bad" } });
    expect(LEAD_TOOL_OPTIONS.propose_flow).toBeDefined();
    expect(lead("propose_flow", { operation: "create", repo: "r1", steps: [{ kind: "inbox", title: "Inbox", onFail: "x" }] })).toEqual(["steps[0]: unknown key 'onFail' (did you mean ifFails?)"]);
  });
});

describe("output diagnostics", () => {
  it.each(["lead", "gateway"] as const)("reports %s output mismatches under Vitest without throwing or changing the result", surface => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.stubEnv("VITEST", "true");
    try {
      const body = { actual: "the handler result" };
      expect(() => reportToolOutput(surface, "list_tasks", OUTPUTS[surface]["list_tasks"]!, body)).not.toThrow();
      expect(write).toHaveBeenCalledWith(expect.stringContaining(`${surface} tool list_tasks: its result disagrees with its output schema`));
      expect(write).toHaveBeenCalledWith(expect.stringContaining("tasks: required"));
      expect(body).toEqual({ actual: "the handler result" });
    } finally {
      write.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});

describe("docs/plans/zod-revamp.md", () => {
  it("marks item 5 done", () => {
    const doc = readFileSync(new URL("../../docs/plans/zod-revamp.md", import.meta.url), "utf8");
    expect(doc).toMatch(/^\| 5 ✅ \| \*\*Lead tool inputs and outputs\*\*/m);
    expect(doc.slice(doc.indexOf("## Done"))).toContain("**5. Lead tools and the MCP gateway**");
  });
});
