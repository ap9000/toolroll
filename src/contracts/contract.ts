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
 * plain code after parsing. `shorten: false` is for a contract with no shorten turn (a parked decision): its
 * description states the bound without promising one.
 */
export function limited(field: string, limitKey: TextLimitKey, options: { shorten?: boolean } = {}): z.ZodString {
  const limit = TEXT_LIMITS[limitKey];
  const unit = limitKey.endsWith("Bytes") ? "bytes" : "characters";
  return z.string().max(limit, { error: `over ${limit.toLocaleString("en-US")} ${unit}` }).describe(limitRule(field, limit, unit, options.shorten ?? true));
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

/**
 * How a contract names a key it doesn't know: the keys a person or model often writes for one it does (`onFail` for
 * `ifFails`, `to` for `goesTo`), tried in order against the keys allowed at that place. Without one that fits, a key
 * spelled close to an allowed one (a case or a letter or two off) is suggested.
 */
export type ContractOptions = {
  aliases?: Readonly<Record<string, readonly string[]>>;
  /** Report explicit null as a wrong value; omitted keeps the historical wording for existing contracts. */
  distinguishNull?: boolean;
};

type Node = { _zod: { def: Def } };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The schema at `path`, including whether that value may be omitted, following arrays, wrappers and unions. */
function nodeAt(schema: Node, input: unknown, path: readonly PropertyKey[]): { def: Def; optional: boolean } | null {
  let node: Node | undefined = schema, value = input;
  let optional = false;
  for (let at = 0; node !== undefined; ) {
    const def: Def = node._zod.def;
    if (def.type === "optional" || def.type === "nullable" || def.type === "readonly") {
      if (def.type === "optional") optional = true;
      node = def["innerType"] as Node;
      continue;
    }
    if (def.type === "lazy") { node = (def["getter"] as () => Node)(); continue; }
    if (def.type === "union") {
      const options = def["options"] as Node[];
      const by = def["discriminator"] as string | undefined;
      const wanted = by !== undefined && isRecord(value) ? value[by] : undefined;
      node = options.find(option => {
        const shape = option._zod.def["shape"] as Record<string, Node> | undefined;
        if (shape === undefined) return false;
        if (by === undefined) return true;
        const literal = shape[by]?._zod.def;
        return literal !== undefined && (literal["values"] as unknown[] | undefined)?.includes(wanted) === true;
      });
      continue;
    }
    if (at === path.length) return { def, optional };
    const part = path[at++];
    optional = false;
    if (def.type === "array" && typeof part === "number") { node = def["element"] as Node; value = Array.isArray(value) ? value[part] : undefined; continue; }
    if (def.type === "object" && typeof part === "string") {
      const shape = def["shape"] as Record<string, Node>;
      node = shape[part] ?? (def["catchall"] as Node | undefined);
      value = isRecord(value) ? value[part] : undefined;
      continue;
    }
    return null;
  }
  return null;
}

/** Edit distance, for "did you mean" (short strings only). */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let last = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const was = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = was;
    }
  }
  return row[b.length]!;
}

/** The allowed key an unknown one most likely meant, or null. */
function suggestion(key: string, known: readonly string[] | null, options: ContractOptions): string | null {
  if (known === null || known.length === 0) return null;
  const alias = options.aliases?.[key]?.find(one => known.includes(one));
  if (alias !== undefined) return alias;
  const close = known
    .map(one => ({ one, far: one.toLowerCase() === key.toLowerCase() ? 0 : distance(one.toLowerCase(), key.toLowerCase()) }))
    .filter(({ one, far }) => far <= (Math.min(one.length, key.length) >= 6 ? 2 : 1))
    .sort((a, b) => a.far - b.far);
  return close[0]?.one ?? null;
}

type Where = { schema?: z.ZodType; input?: unknown; options?: ContractOptions };

function issuesOf(issue: z.core.$ZodIssue, where: Where = {}): ContractIssue[] {
  const at = pathOf(issue.path);
  const one = (kind: ContractIssue["kind"], what: string): ContractIssue => ({ path: at, kind, line: `${at}: ${what}` });
  switch (issue.code) {
    case "unrecognized_keys": {
      const def = where.schema === undefined ? undefined : nodeAt(where.schema as unknown as Node, where.input, issue.path)?.def;
      const known = def?.type === "object" ? Object.keys(def["shape"] as Record<string, unknown>) : null;
      return issue.keys.map(key => {
        const meant = suggestion(key, known, where.options ?? {});
        return { path: at, kind: "unknown-key" as const, line: `${at}: unknown key '${key}'${meant === null ? "" : ` (did you mean ${meant}?)`}` };
      });
    }
    case "invalid_type": {
      const missing = "input" in issue ? issue.input === undefined : / received undefined$/.test(issue.message);
      // Keep required-null wording for required fields; an optional field given null has the wrong type, and so does
      // any null when the caller distinguishes null from missing.
      const optional = where.schema !== undefined && nodeAt(where.schema as unknown as Node, where.input, issue.path)?.optional === true;
      if (missing || (!optional && !where.options?.distinguishNull && "input" in issue && issue.input === null && issue.expected !== "null")) return [one("required", "required")];
      const expected = issue.expected === "array" ? "an array" : issue.expected === "object" ? "an object" : issue.expected === "int" ? "an integer" : issue.expected === "null" ? "null" : `a ${issue.expected}`;
      return [one("wrong-type", `must be ${expected}${"input" in issue ? ` (got ${got(issue.input)})` : ""}`)];
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
    case "invalid_union": {
      // A discriminated union names its choices (`steps[0].kind: must be one of "inbox", "task", ...`).
      const by = (issue as { discriminator?: unknown }).discriminator, options = (issue as { options?: unknown }).options;
      if (typeof by === "string" && Array.isArray(options)) {
        const given = "input" in issue && isRecord(issue.input) ? issue.input[by] : undefined;
        const path = at === "payload" || issue.path.at(-1) === by ? at : `${at}.${by}`;
        const missing = given === undefined || (given === null && !where.options?.distinguishNull);
        const line = missing ? "required" : `must be one of ${options.map(value => JSON.stringify(value)).join(", ")}`;
        return [{ path, kind: missing ? "required" : "bad-value", line: `${path}: ${line}` }];
      }
      return [one("invalid", "does not match any allowed shape")];
    }
    case "invalid_format":
      // A pattern's own words say what it wants (`must be a short id: lowercase letters, numbers and dashes`).
      return [one("bad-value", issue.message.startsWith("Invalid") ? `must match ${issue.format === "regex" ? (issue as { pattern?: string }).pattern ?? "its pattern" : issue.format}` : issue.message)];
    default:
      return [one("invalid", issue.message)];
  }
}

/**
 * A Zod error as path-named issues, in the error's own order. Given the schema and input it came from, an unknown key
 * also says which allowed key it most likely meant (`unknown key 'onFail' (did you mean ifFails?)`).
 */
export function contractIssues(error: z.ZodError, where: Where = {}): ContractIssue[] {
  return error.issues.flatMap(issue => issuesOf(issue, where));
}

/** A Zod error as path-named lines: `steps[0].routes[0].goesTo: required`, `routes[0]: unknown key 'to'`. */
export function contractError(error: z.ZodError, where: Where = {}): string[] {
  return contractIssues(error, where).map(issue => issue.line);
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
export function parseContract<T>(schema: z.ZodType<T>, input: unknown, options: ContractOptions = {}): ContractResult<T> {
  const parsed = schema.safeParse(input, { reportInput: true });
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, issues: contractIssues(parsed.error, { schema, input, options }) };
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
  options: ContractOptions = {},
): ContractResult<T> {
  const current = schema.shape.version.value;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, issues: [{ path: "payload", kind: "wrong-type", line: `payload: must be an object (got ${got(input)})` }] };
  }
  const body = input as Record<string, unknown>;
  const version = Object.prototype.hasOwnProperty.call(body, "version") ? body["version"] : 0;
  if (version === current) return parseContract(schema, body, options);
  if (typeof version === "number" && Number.isInteger(version) && version > current) {
    return { ok: false, issues: [{ path: "version", kind: "newer-version", line: `version: made by a newer Toolroll (version ${version}; this one reads up to ${current})` }] };
  }
  const upgrade = typeof version === "number" ? upgrades[version] : undefined;
  if (upgrade === undefined) {
    return { ok: false, issues: [{ path: "version", kind: "bad-value", line: `version: unknown version ${JSON.stringify(version)} (this Toolroll reads ${current}${Object.keys(upgrades).length === 0 ? "" : ` and ${Object.keys(upgrades).join(", ")}`})` }] };
  }
  return parseContract(schema, upgrade(body), options);
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
