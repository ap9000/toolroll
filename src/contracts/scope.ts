/**
 * A task's scope: its goal, what is out of it, the paths it expects to touch and the acceptance rubric an operator
 * signs. One schema for the terms and one for a criterion, both made from the plan contract's own fields
 * (src/contracts/plan.ts) rather than restated; a scope may name 50 paths where a plan names 32. The rules JSON Schema
 * cannot state — UTF-8 byte limits, control characters, duplicate criterion ids and evidence kinds — run in plain code
 * after parsing, each with a path-named error.
 *
 * Reading keeps what every release accepted: a criterion's unknown keys are ignored, a null or empty `how` reads as
 * null, and an absent or empty rubric reads as none (whether that is allowed is the caller's question). The digest
 * (scope.ts `digestOf`) reads the parsed values, so a saved scope's digest is what it always was.
 *
 * The schemas are built lazily: plan.ts reads the evidence kinds through scope.ts, which reads this module, so in
 * either load order plan.ts may still be loading when this module is.
 */

import { z } from "zod";
import { hasForbiddenControls } from "../decision.js";
import { TEXT_LIMITS } from "../text-limits.js";
import { ACCEPTANCE_LIMITS } from "./acceptance-terms.js";
import { contractProblemOf, parseContract, type ContractProblem } from "./contract.js";
import { acceptanceCriterionSchema as planCriterionSchema, planSchema } from "./plan.js";

/** A criterion as saved and as every reader returns it: the plan's criterion with `how` always present (null for none). */
export const savedCriterionSchema = z.lazy(() => planCriterionSchema.extend({ how: planCriterionSchema.shape.how.unwrap() }));

export type AcceptanceCriterion = z.infer<typeof savedCriterionSchema>;

/** A rubric as saved: at most twelve criteria (an empty one is a scope filed before rubrics, or by a road with none). */
export const rubricSchema = z.lazy(() => z.array(savedCriterionSchema).max(ACCEPTANCE_LIMITS.criteria));

/** A rubric as a row stores it: exactly the keys this code writes (`how` may be absent on an older row). */
export const storedRubricSchema = z.lazy(() => z.array(planCriterionSchema).max(ACCEPTANCE_LIMITS.criteria));

/** What a model drafts as a rubric (the lead's proposals): the plan's criteria, one to twelve. */
export const rubricInputSchema = z.lazy(() => z.array(planCriterionSchema).min(1).max(ACCEPTANCE_LIMITS.criteria));

/** A scope's terms as filed: the plan's goal, out-of-scope text and touch paths (up to 50), and its rubric. */
export const scopeTermsSchema = z.lazy(() =>
  z.strictObject({
    goal: planSchema.shape.goal,
    outOfScope: planSchema.shape.outOfScope,
    touches: z.array(planSchema.shape.touches.unwrap().element).max(TEXT_LIMITS.scopeTouches).optional(),
    acceptance: rubricSchema.optional(),
  }),
);

export type ScopeTerms = z.infer<typeof scopeTermsSchema>;

export type AcceptanceProblem = ContractProblem;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A criterion as the reader takes it: only the fields it knows, a null or empty `how` as null. Anything else as is. */
function criterionBody(entry: unknown): unknown {
  if (!isRecord(entry)) return entry;
  const out: Record<string, unknown> = {};
  for (const field of ["id", "statement", "evidence"] as const) if (entry[field] !== undefined) out[field] = entry[field];
  out["how"] = entry["how"] === undefined || entry["how"] === "" ? null : entry["how"];
  return out;
}

/** The plain-code rules for one criterion JSON Schema cannot state: UTF-8 bytes and control characters. */
function criterionTextProblems(criterion: AcceptanceCriterion, at: string): AcceptanceProblem[] {
  const out: AcceptanceProblem[] = [];
  for (const [field, limit] of [["id", ACCEPTANCE_LIMITS.id], ["statement", ACCEPTANCE_LIMITS.statement], ["how", ACCEPTANCE_LIMITS.how]] as const) {
    const value = criterion[field];
    const path = `${at}.${field}`;
    if (value === null) continue;
    if (Buffer.byteLength(value, "utf8") > limit) out.push({ reason: `${path}-too-long`, message: `${path}: over ${limit.toLocaleString("en-US")} bytes` });
    else if (hasForbiddenControls(value)) out.push({ reason: `${path}-controls`, message: `${path}: carries control characters that could become terminal escapes` });
  }
  return out;
}

const named = (problems: readonly AcceptanceProblem[], path: string) => problems.some(one => one.message.startsWith(`${path}:`));

/**
 * Read a rubric from already-JSON-parsed input (a console form, the CLI, a routine or template, a model's proposal,
 * a saved row): every problem at once, each naming its path. Absent or empty is `[]` with no problems. A criterion
 * that reads cleanly is kept even when another does not, as before; any problem means the rubric is refused.
 */
export function readAcceptance(value: unknown): { criteria: AcceptanceCriterion[]; problems: AcceptanceProblem[] } {
  if (value === undefined || value === null) return { criteria: [], problems: [] };
  const body = Array.isArray(value) ? value.map(criterionBody) : value;
  const parsed = parseContract(z.object({ acceptance: rubricSchema }), { acceptance: body });
  const issues = parsed.ok ? [] : parsed.issues;
  // The list itself is wrong (not a list, too long): nothing in it is read.
  if (!Array.isArray(body) || issues.some(one => one.path === "acceptance")) return { criteria: [], problems: issues.map(contractProblemOf) };
  const criteria: AcceptanceCriterion[] = [];
  const seen = new Set<string>();
  const problems: AcceptanceProblem[] = [];
  body.forEach((entry, index) => {
    const at = `acceptance[${index}]`;
    const own = issues.filter(one => one.path === at || one.path.startsWith(`${at}.`) || one.path.startsWith(`${at}[`)).map(contractProblemOf);
    const read = own.length === 0 ? savedCriterionSchema.safeParse(entry) : null;
    const text = read?.success === true ? criterionTextProblems(read.data, at) : [];
    const kinds = read?.success === true ? read.data.evidence : [];
    const twice = kinds.flatMap((kind, k) => (kinds.indexOf(kind) === k ? [] : [{ reason: `${at}-duplicate-evidence-kind`, message: `${at}.evidence[${k}]: "${kind}" appears twice` }]));
    problems.push(...own, ...text, ...twice);
    // A duplicate id is a problem with the rubric, not with either criterion: both stay readable, as before.
    const id = isRecord(entry) ? entry["id"] : undefined;
    const idClean = typeof id === "string" && !named(own, `${at}.id`) && !named(text, `${at}.id`);
    if (idClean && seen.has(id)) problems.push({ reason: `${at}-duplicate-id`, message: `${at}.id: "${id}" appears twice` });
    if (idClean) seen.add(id);
    if (read?.success === true && text.length === 0 && twice.length === 0) criteria.push(read.data);
  });
  return { criteria, problems };
}

export type ScopeTermsResult =
  | { ok: true; terms: Omit<ScopeTerms, "acceptance"> & { acceptance: AcceptanceCriterion[] } }
  | { ok: false; field: "goal" | "outOfScope" | "touches" | "acceptance" | "payload"; problems: AcceptanceProblem[] };

/** Read a scope's terms as a person or a model files them; the first field refused names the refusal. */
export function readScopeTerms(input: unknown): ScopeTermsResult {
  if (!isRecord(input)) return { ok: false, field: "payload", problems: [{ reason: "bad-payload", message: "payload: must be an object" }] };
  const acceptance = readAcceptance(input["acceptance"]);
  const parsed = parseContract(scopeTermsSchema, { ...input, acceptance: acceptance.criteria });
  if (!parsed.ok) {
    const first = parsed.issues[0]!.path.replace(/[[.].*$/, "") as "goal" | "outOfScope" | "touches" | "payload";
    return { ok: false, field: first, problems: parsed.issues.filter(one => one.path.replace(/[[.].*$/, "") === first).map(contractProblemOf) };
  }
  if (acceptance.problems.length > 0) return { ok: false, field: "acceptance", problems: acceptance.problems };
  return { ok: true, terms: { ...parsed.value, acceptance: acceptance.criteria } };
}
