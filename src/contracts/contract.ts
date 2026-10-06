/**
 * The one way Toolroll describes a contract (docs/plans/zod-revamp.md): one Zod schema, and everything else — the
 * TypeScript type, the runtime check, the JSON Schema a model gets, the text limits — derived from it.
 *
 * The helpers here hold the ground rules every contract shares: limits come from TEXT_LIMITS, persisted payloads are
 * versioned, refusals name the path, and a model-facing schema is exactly what its JSON Schema says (no refinements or
 * transforms; those checks run in plain code after parsing, with a named error).
 */

import { z } from "zod";
import { limitRule, TEXT_LIMITS, type TextLimitKey } from "../text-limits.js";

/**
 * A string bounded by its TEXT_LIMITS entry, never a literal. The limit rule rides along as the field's description,
 * so a model reads the bound before it writes. Zod counts UTF-16 code units; for a limit named in bytes this is the
 * schema's necessary bound (a string within N bytes is within N code units), and the byte count itself is checked in
 * plain code after parsing.
 */
export function limited(field: string, limitKey: TextLimitKey): z.ZodString {
  const limit = TEXT_LIMITS[limitKey];
  const unit = limitKey.endsWith("Bytes") ? "bytes" : "characters";
  return z.string().max(limit, { error: `over ${limit.toLocaleString("en-US")} ${unit}` }).describe(limitRule(field, limit, unit));
}

/** A versioned payload envelope: a strict object whose `version` is exactly `version`. */
export function versioned<V extends number, S extends z.ZodRawShape>(version: V, shape: S) {
  return z.strictObject({ version: z.literal(version), ...shape });
}

/** One path-named refusal: where, what kind, and the line a person (or the repair turn) reads. */
export type ContractIssue = {
  /** `steps[0].routes[0].goesTo`; `payload` for the top level. */
  path: string;
  kind: "required" | "empty" | "unknown-key" | "too-long" | "too-many" | "too-few" | "wrong-type" | "bad-value" | "newer-version" | "invalid";
  /** The line itself: `steps[0].routes[0].goesTo: required`. */
  line: string;
};

/** `["steps", 0, "routes", 0, "goesTo"]` as `steps[0].routes[0].goesTo`. */
export function pathOf(path: readonly PropertyKey[]): string {
  let out = "";
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    else out += out === "" ? String(part) : `.${String(part)}`;
  }
  return out === "" ? "payload" : out;
}

function got(input: unknown): string {
  if (input === null) return "null";
  if (Array.isArray(input)) return "an array";
  return typeof input === "object" ? "an object" : `a ${typeof input}`;
}

function issuesOf(issue: z.core.$ZodIssue): ContractIssue[] {
  const at = pathOf(issue.path);
  const one = (kind: ContractIssue["kind"], what: string): ContractIssue => ({ path: at, kind, line: `${at}: ${what}` });
  switch (issue.code) {
    case "unrecognized_keys":
      return issue.keys.map(key => ({ path: at, kind: "unknown-key" as const, line: `${at}: unknown key '${key}'` }));
    case "invalid_type": {
      const missing = "input" in issue ? issue.input === undefined : / received undefined$/.test(issue.message);
      if (missing) return [one("required", "required")];
      return [one("wrong-type", `must be ${issue.expected === "array" ? "an array" : issue.expected === "object" ? "an object" : `a ${issue.expected}`}${"input" in issue ? ` (got ${got(issue.input)})` : ""}`)];
    }
    case "too_big":
      if (issue.origin === "array" || issue.origin === "set") return [one("too-many", `at most ${String(issue.maximum)} items`)];
      if (issue.origin === "number" || issue.origin === "int" || issue.origin === "bigint") return [one("bad-value", `at most ${String(issue.maximum)}`)];
      return [one("too-long", issue.origin === "string" && issue.message.startsWith("over ") ? issue.message : `at most ${String(issue.maximum)}${issue.origin === "string" ? " characters" : ""}`)];
    case "too_small":
      if (issue.origin === "string" && Number(issue.minimum) === 1) return [one("empty", "must not be empty")];
      if (issue.origin === "array" || issue.origin === "set") return [one("too-few", `at least ${String(issue.minimum)} item${Number(issue.minimum) === 1 ? "" : "s"}`)];
      if (issue.origin === "number" || issue.origin === "int" || issue.origin === "bigint") return [one("bad-value", `at least ${String(issue.minimum)}`)];
      return [one("too-few", `at least ${String(issue.minimum)}`)];
    case "invalid_value":
      return [one("bad-value", `must be ${issue.values.length === 1 ? JSON.stringify(issue.values[0]) : `one of ${issue.values.map(value => JSON.stringify(value)).join(", ")}`}`)];
    case "invalid_union":
      return [one("invalid", "does not match any allowed shape")];
    default:
      return [one("invalid", issue.message)];
  }
}

/** A Zod error as path-named issues, in the error's own order. */
export function contractIssues(error: z.ZodError): ContractIssue[] {
  return error.issues.flatMap(issuesOf);
}

/** A Zod error as path-named lines: `steps[0].routes[0].goesTo: required`, `routes[0]: unknown key 'to'`. */
export function contractError(error: z.ZodError): string[] {
  return contractIssues(error).map(issue => issue.line);
}

/** A refusal as a reader reports it: a stable reason code, and the path-named line as the message. */
export type ContractProblem = { reason: string; message: string };

/**
 * A contract issue as a problem with a reason code built from its path — `missing-goal`, `criteria[0].how-too-long`,
 * `checks-too-many`, `payload-unknown-key`, `bad-version`, `newer-version` — so callers that branch on a reason, and
 * durable outcomes that recorded one, read the same as before the contract.
 */
export function contractProblemOf(issue: ContractIssue): ContractProblem {
  const at = issue.path;
  const reason = (() => {
    switch (issue.kind) {
      case "required":
      case "empty":
      case "too-few":
        return `missing-${at}`;
      case "too-long":
        return `${at}-too-long`;
      case "too-many":
        return `${at}-too-many`;
      case "unknown-key":
        return `${at}-unknown-key`;
      case "newer-version":
        return "newer-version";
      default:
        return `bad-${at}`;
    }
  })();
  return { reason, message: issue.line };
}

export type ContractResult<T> = { ok: true; value: T } | { ok: false; issues: ContractIssue[] };

/** Parse with the input reported, so a missing field reads `required` rather than a wrong type. */
export function parseContract<T>(schema: z.ZodType<T>, input: unknown): ContractResult<T> {
  const parsed = schema.safeParse(input, { reportInput: true });
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, issues: contractIssues(parsed.error) };
}

/**
 * Read a versioned payload. The current version parses as itself; an older known version (0 for a payload saved
 * before it carried `version`) is upgraded by its adapter and then parsed by the same schema; a newer version is
 * refused plainly; anything else is an unknown version.
 */
export function readVersioned<T>(
  schema: z.ZodType<T> & { shape: { version: z.ZodLiteral<number> } },
  input: unknown,
  upgrades: Readonly<Record<number, (payload: Record<string, unknown>) => unknown>> = {},
): ContractResult<T> {
  const current = schema.shape.version.value;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, issues: [{ path: "payload", kind: "wrong-type", line: `payload: must be an object (got ${got(input)})` }] };
  }
  const body = input as Record<string, unknown>;
  const version = Object.prototype.hasOwnProperty.call(body, "version") ? body["version"] : 0;
  if (version === current) return parseContract(schema, body);
  if (typeof version === "number" && Number.isInteger(version) && version > current) {
    return { ok: false, issues: [{ path: "version", kind: "newer-version", line: `version: made by a newer Toolroll (version ${version}; this one reads up to ${current})` }] };
  }
  const upgrade = typeof version === "number" ? upgrades[version] : undefined;
  if (upgrade === undefined) {
    return { ok: false, issues: [{ path: "version", kind: "bad-value", line: `version: unknown version ${JSON.stringify(version)} (this Toolroll reads ${current}${Object.keys(upgrades).length === 0 ? "" : ` and ${Object.keys(upgrades).join(", ")}`})` }] };
  }
  return parseContract(schema, upgrade(body));
}

/** The Zod node kinds a model-facing schema may use: each says exactly what its JSON Schema says. */
const MODEL_FACING_TYPES = new Set(["string", "number", "int", "boolean", "null", "literal", "enum", "array", "object", "optional", "nullable", "union", "tuple", "record", "lazy", "readonly", "unknown", "any"]);

/** Checks that only constrain (never rewrite) and that JSON Schema can state. */
const MODEL_FACING_CHECKS = new Set(["max_length", "min_length", "length_equals", "greater_than", "less_than", "multiple_of", "number_format", "string_format", "size_equals", "max_size", "min_size"]);

type Def = { type: string; checks?: { _zod: { def: { check: string } } }[]; [key: string]: unknown };

/** Every node of a schema graph, refusing a refinement, transform, preprocess or unknown node by its schema path. */
function assertModelFacing(schema: z.ZodType, at: string, seen: Set<unknown>): void {
  if (seen.has(schema)) return;
  seen.add(schema);
  const def = (schema as unknown as { _zod: { def: Def } })._zod.def;
  const where = at === "" ? "the schema" : at;
  if (def.type === "pipe") {
    const into = (def["in"] as { _zod: { def: Def } } | undefined)?._zod.def.type;
    const out = (def["out"] as { _zod: { def: Def } } | undefined)?._zod.def.type;
    const what = into === "transform" ? "preprocess" : out === "transform" ? "transform" : "pipe";
    throw new Error(`toModelSchema: ${where} uses ${what}; a model-facing schema must be JSON-Schema-exact — check it in plain code after parsing`);
  }
  if (def.type === "transform") throw new Error(`toModelSchema: ${where} uses transform; a model-facing schema must be JSON-Schema-exact — check it in plain code after parsing`);
  if (!MODEL_FACING_TYPES.has(def.type)) throw new Error(`toModelSchema: ${where} uses a ${def.type} node, which a model-facing schema may not use`);
  for (const check of def.checks ?? []) {
    const kind = check._zod.def.check;
    if (kind === "custom") throw new Error(`toModelSchema: ${where} uses refine or superRefine; a model-facing schema must be JSON-Schema-exact — check it in plain code after parsing`);
    if (!MODEL_FACING_CHECKS.has(kind)) throw new Error(`toModelSchema: ${where} uses a ${kind} check, which rewrites or cannot be stated in JSON Schema`);
  }
  const child = (value: unknown, path: string) => assertModelFacing(value as z.ZodType, path, seen);
  const join = (key: string) => (at === "" ? key : `${at}.${key}`);
  switch (def.type) {
    case "object":
      for (const [key, value] of Object.entries(def["shape"] as Record<string, unknown>)) child(value, join(key));
      // A strict object's catchall is `never` (additionalProperties: false); any other catchall is a schema too.
      if (def["catchall"] !== undefined && (def["catchall"] as { _zod: { def: Def } })._zod.def.type !== "never") child(def["catchall"], join("*"));
      break;
    case "array":
      child(def["element"], `${at}[]`);
      break;
    case "optional":
    case "nullable":
    case "readonly":
      child(def["innerType"], at);
      break;
    case "union":
      (def["options"] as unknown[]).forEach((option, index) => child(option, `${at}|${index}`));
      break;
    case "tuple":
      (def["items"] as unknown[]).forEach((item, index) => child(item, `${at}[${index}]`));
      if (def["rest"] !== undefined && def["rest"] !== null) child(def["rest"], `${at}[]`);
      break;
    case "record":
      child(def["keyType"], `${at}{key}`);
      child(def["valueType"], `${at}{}`);
      break;
    case "lazy":
      child((def["getter"] as () => unknown)(), at);
      break;
  }
}

/**
 * The JSON Schema a model gets for `schema` (Claude's `--json-schema`). Throws when the schema uses refine,
 * superRefine, transform or preprocess anywhere: what a model is told must be everything the schema checks.
 */
export function toModelSchema(schema: z.ZodType): Record<string, unknown> {
  assertModelFacing(schema, "", new Set());
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "throw" }) as Record<string, unknown>;
  return json;
}
