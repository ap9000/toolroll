import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { exactAcceptance, parseAcceptanceCriteria } from "../scope.js";
import { TEXT_LIMITS } from "../text-limits.js";
import { toModelSchema } from "./contract.js";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import { acceptanceCriterionSchema, planSchema } from "./plan.js";
import { readScopeTerms, rubricInputSchema, rubricSchema, savedCriterionSchema, scopeTermsSchema } from "./scope.js";
import { replayRows, scopeFixtures } from "../../test/scope-replay.js";

const { rows, baseline } = scopeFixtures();

const rubricRead = (input: unknown): SampleVerdict => {
  const read = parseAcceptanceCriteria(input);
  return read.problems.length === 0 ? { ok: true } : { ok: false, lines: read.problems.map(one => one.message) };
};
const termsRead = (input: unknown): SampleVerdict => {
  const read = readScopeTerms(input);
  return read.ok ? { ok: true } : { ok: false, lines: read.problems.map(one => one.message) };
};

const json = (value: unknown) => (value === null ? null : (JSON.parse(String(value)) as unknown));
const savedRubrics = [...rows.task_scope, ...rows.routine].map(row => ({ name: `${String(row["task_id"] ?? row["id"])} rubric`, input: json(row["acceptance_json"]) }));
const savedTerms = rows.task_scope.map(row => ({
  name: `${String(row["task_id"])} terms`,
  input: { goal: row["goal"], outOfScope: row["out_of_scope"], touches: json(row["touches"]), acceptance: json(row["acceptance_json"]) },
}));
const c1 = { id: "c1", statement: "It works.", how: null, evidence: ["check"] };

describe("the acceptance criterion contract", () => {
  it("is the plan contract's criterion, `how` always present", () => {
    expect(toModelSchema(savedCriterionSchema)).toEqual({ ...toModelSchema(acceptanceCriterionSchema), required: ["id", "statement", "how", "evidence"] });
    expect(toModelSchema(rubricInputSchema)).toEqual({ type: "array", minItems: 1, maxItems: 12, items: toModelSchema(acceptanceCriterionSchema) });
  });

  it("holds: the round trip loses nothing, every saved rubric reads, malformed ones are refused by path", () => {
    assertContract({
      schema: rubricSchema,
      read: rubricRead,
      valid: [
        ...savedRubrics,
        { name: "a criterion with an unknown key, ignored as before", input: [{ ...c1, approved: true }] },
        { name: "an empty how reads as none", input: [{ ...c1, how: "" }] },
        { name: "a statement of exactly 1,000 bytes", input: [{ ...c1, statement: "x".repeat(TEXT_LIMITS.acceptanceStatementBytes) }] },
        { name: "twelve criteria", input: Array.from({ length: 12 }, (_, index) => ({ ...c1, id: `c${index}` })) },
      ],
      invalid: [
        { name: "not a list", input: "c1: it works", paths: ["acceptance"] },
        { name: "thirteen criteria", input: Array.from({ length: 13 }, (_, index) => ({ ...c1, id: `c${index}` })), paths: ["acceptance"] },
        { name: "not an object", input: ["c1"], paths: ["acceptance[0]"] },
        { name: "no id", input: [{ ...c1, id: null }], paths: ["acceptance[0].id"] },
        { name: "an empty statement", input: [{ ...c1, statement: "" }], paths: ["acceptance[0].statement"] },
        { name: "no evidence", input: [{ ...c1, evidence: [] }], paths: ["acceptance[0].evidence"] },
        { name: "an unknown evidence kind", input: [{ ...c1, evidence: ["vibes"] }], paths: ["acceptance[0].evidence[0]"] },
        { name: "an evidence kind twice", input: [{ ...c1, evidence: ["check", "check"] }], paths: ["acceptance[0].evidence[1]"] },
        { name: "an id over 40 UTF-8 bytes", input: [{ ...c1, id: "é".repeat(21) }], paths: ["acceptance[0].id"] },
        { name: "a how over 500 bytes", input: [{ ...c1, how: "x".repeat(501) }], paths: ["acceptance[0].how"] },
        { name: "control characters", input: [{ ...c1, statement: "look\u001b]0;pwned\u0007" }], paths: ["acceptance[0].statement"] },
        { name: "a duplicate id", input: [c1, { ...c1, statement: "Again." }], paths: ["acceptance[1].id"] },
      ],
    });
  });

  it("names the path and keeps a reason code; a clean criterion still reads beside a bad one", () => {
    expect(parseAcceptanceCriteria([c1, { ...c1, statement: "Again." }, { id: "c3", statement: "", evidence: ["check"] }])).toEqual({
      criteria: [c1, { ...c1, statement: "Again." }],
      problems: [
        { reason: "acceptance[1]-duplicate-id", message: 'acceptance[1].id: "c1" appears twice' },
        { reason: "missing-acceptance[2].statement", message: "acceptance[2].statement: must not be empty" },
      ],
    });
    expect(parseAcceptanceCriteria(Array.from({ length: 13 }, () => c1)).problems).toEqual([{ reason: "acceptance-too-many", message: "acceptance: at most 12 items" }]);
    expect(parseAcceptanceCriteria([{ ...c1, how: "x".repeat(501) }]).problems).toEqual([{ reason: "acceptance[0].how-too-long", message: "acceptance[0].how: over 500 bytes" }]);
  });

  it("reads a stored rubric strictly: a key this code never writes is refused, an absent how is not", () => {
    expect(exactAcceptance(JSON.stringify([{ id: "c1", statement: "s", evidence: ["check"] }]))).toEqual({ ok: true, criteria: [{ id: "c1", statement: "s", how: null, evidence: ["check"] }] });
    expect(exactAcceptance(JSON.stringify([{ ...c1, extra: 1 }]))).toEqual({ ok: false, problem: "rubric entry 1 carries a key this code never writes" });
    expect(exactAcceptance(JSON.stringify(["c1"]))).toEqual({ ok: false, problem: "rubric entry 1 is not an object" });
    expect(exactAcceptance(JSON.stringify([c1, { id: 7, statement: "s", how: null, evidence: ["check"] }]))).toEqual({ ok: false, problem: "the rubric does not parse: acceptance[1].id: must be a string (got a number)" });
  });
});

describe("the scope terms contract", () => {
  it("reuses the plan's fields; a scope names up to 50 paths where a plan names 32", () => {
    const terms = toModelSchema(scopeTermsSchema) as { properties: Record<string, Record<string, unknown>> };
    const plan = toModelSchema(planSchema) as { properties: Record<string, Record<string, unknown>> };
    expect(terms.properties["goal"]).toEqual(plan.properties["goal"]);
    expect(terms.properties["outOfScope"]).toEqual(plan.properties["outOfScope"]);
    expect(terms.properties["touches"]).toEqual({ ...plan.properties["touches"], maxItems: TEXT_LIMITS.scopeTouches });
    expect(TEXT_LIMITS.scopeTouches).toBe(50);
  });

  it("holds: the round trip loses nothing, every saved scope's terms read, malformed ones are refused by path", () => {
    expect(savedTerms.length).toBe(rows.task_scope.length);
    assertContract({
      schema: scopeTermsSchema,
      read: termsRead,
      valid: [
        ...savedTerms,
        { name: "goal only", input: { goal: "Fix it." } },
        { name: "fifty touches", input: { goal: "g", touches: Array.from({ length: 50 }, (_, index) => `src/${index}.ts`), acceptance: [c1] } },
      ],
      invalid: [
        { name: "no goal", input: { touches: [] }, paths: ["goal"] },
        { name: "a goal over 8,000 characters", input: { goal: "x".repeat(TEXT_LIMITS.goal + 1) }, paths: ["goal"] },
        { name: "51 touches", input: { goal: "g", touches: Array.from({ length: 51 }, (_, index) => `src/${index}.ts`) }, paths: ["touches"] },
        { name: "an empty touch", input: { goal: "g", touches: [""] }, paths: ["touches[0]"] },
        { name: "an unknown key", input: { goal: "g", touch: ["src/a.ts"] }, paths: ["payload"] },
        { name: "a bad rubric", input: { goal: "g", acceptance: [{ ...c1, evidence: ["vibes"] }] }, paths: ["acceptance[0].evidence[0]"] },
      ],
    });
    expect(readScopeTerms({ goal: "g", touchs: [] })).toMatchObject({ ok: false, field: "payload", problems: [{ message: "payload: unknown key 'touchs' (did you mean touches?)" }] });
  });
});

describe("saved scopes and standing orders, replayed read-only", () => {
  it("re-derive every recorded digest, rubric and route byte for byte as before the contracts", () => {
    expect(rows.task_scope.length).toBe(20);
    expect(rows.routine.length).toBe(1);
    expect(JSON.parse(JSON.stringify(replayRows(rows)))).toEqual(baseline);
  });

  it("re-derive the digest each row stores, and every sealed route re-encodes to its stored bytes", () => {
    for (const row of [...baseline.task_scope, ...baseline.routine]) {
      expect(row.digest, row.key).toBe(row.stored.digest);
      if (row.stored.approvedDigest !== null) expect(row.approvedDigest, row.key).toBe(row.stored.approvedDigest);
      for (const route of [row.route, row.approvedRoute]) if (route !== null) expect(route.sameBytes, row.key).toBe(true);
    }
    const routes = baseline.task_scope.flatMap(row => [row.route, row.approvedRoute]).filter(one => one !== null);
    expect(routes.map(one => (JSON.parse(one.read!) as { version: number }).version).sort()).toEqual([...Array(5).fill(1), ...Array(15).fill(2)]);
  });
});

describe("docs/plans/zod-revamp.md", () => {
  it("marks wave 2 item 10 done", () => {
    const doc = readFileSync(new URL("../../docs/plans/zod-revamp.md", import.meta.url), "utf8");
    expect(doc).toMatch(/^\| 10 ✅ \| \*\*Scope, acceptance criteria and sealed routes\*\*/m);
    expect(doc.slice(doc.indexOf("## Done"))).toContain("**10. Scope, acceptance criteria and sealed routes**");
  });
});
