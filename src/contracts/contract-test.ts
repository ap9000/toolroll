/**
 * The contract test every schema gets (docs/plans/zod-revamp.md, ground rule 7), framework-neutral so any test file
 * can use it: each check returns the failures it found (empty when the contract holds), and `assertContract` throws
 * them all at once.
 *
 * - The round trip toJSONSchema → fromJSONSchema → toJSONSchema loses no keyword.
 * - Listed valid samples parse, including payloads saved by older versions.
 * - Listed invalid samples are refused, and the refusal names each listed path (`steps[0].routes[0].goesTo: ...`).
 */

import { z } from "zod";
import { toModelSchema } from "./contract.js";

/** Every keyword in a JSON Schema as `pointer keyword=value`, sorted, so two schemas compare keyword by keyword. */
export function jsonSchemaKeywords(schema: unknown, pointer = ""): string[] {
  if (Array.isArray(schema)) return schema.flatMap((item, index) => jsonSchemaKeywords(item, `${pointer}/${index}`)).sort();
  if (schema === null || typeof schema !== "object") return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (value !== null && typeof value === "object") {
      if (Array.isArray(value) && value.every(item => item === null || typeof item !== "object")) out.push(`${pointer} ${key}=${JSON.stringify(value)}`);
      else out.push(...jsonSchemaKeywords(value, `${pointer}/${key}`));
    } else {
      out.push(`${pointer} ${key}=${JSON.stringify(value)}`);
    }
  }
  return out.sort();
}

/** The keywords the JSON Schema round trip drops or changes; empty when it loses nothing. */
export function roundTripLoss(schema: z.ZodType): string[] {
  const before = toModelSchema(schema);
  const after = toModelSchema(z.fromJSONSchema(before) as z.ZodType);
  const kept = new Set(jsonSchemaKeywords(after));
  return jsonSchemaKeywords(before).filter(keyword => !kept.has(keyword)).map(keyword => `lost in the round trip: ${keyword}`);
}

/** What a contract's reader says about one input: accepted, or refused with path-named lines. */
export type SampleVerdict = { ok: true } | { ok: false; lines: readonly string[] };

export type ValidSample = { name: string; input: unknown };
/** An input the contract refuses; `paths` are the paths its refusal must name (`goal`, `acceptance[0].evidence[0]`). */
export type InvalidSample = { name: string; input: unknown; paths: readonly string[] };

export type ContractSpec = {
  /** The model-facing schema, when the contract has one: its JSON Schema must survive the round trip. */
  schema?: z.ZodType;
  /** The contract's reader, the same one production uses. */
  read: (input: unknown) => SampleVerdict;
  valid: readonly ValidSample[];
  invalid: readonly InvalidSample[];
};

/** Every way the samples disagree with the contract: a valid one refused, an invalid one accepted, a path unnamed. */
export function replaySamples(spec: Pick<ContractSpec, "read" | "valid" | "invalid">): string[] {
  const failures: string[] = [];
  for (const sample of spec.valid) {
    const verdict = spec.read(sample.input);
    if (!verdict.ok) failures.push(`${sample.name}: refused — ${verdict.lines.join("; ")}`);
  }
  for (const sample of spec.invalid) {
    const verdict = spec.read(sample.input);
    if (verdict.ok) {
      failures.push(`${sample.name}: accepted, expected a refusal naming ${sample.paths.join(", ")}`);
      continue;
    }
    for (const path of sample.paths) {
      if (!verdict.lines.some(line => line.startsWith(`${path}:`))) failures.push(`${sample.name}: no line names ${path} — ${verdict.lines.join("; ")}`);
    }
  }
  return failures;
}

/** Every failure of the contract test, round trip and samples together. */
export function contractFailures(spec: ContractSpec): string[] {
  return [...(spec.schema === undefined ? [] : roundTripLoss(spec.schema)), ...replaySamples(spec)];
}

/** Throws every failure at once; returns quietly when the contract holds. */
export function assertContract(spec: ContractSpec): void {
  const failures = contractFailures(spec);
  if (failures.length > 0) throw new Error(`the contract does not hold:\n${failures.map(one => `- ${one}`).join("\n")}`);
}
