import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TEXT_LIMITS } from "../text-limits.js";
import { parseContract, toModelSchema } from "./contract.js";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import { decisionChangeSchema, decisionRecordSchema, decisionSchema, type Decision } from "./project-memory.js";
import { savedRows } from "../../test/context-fixture.js";

const reader = (schema: Parameters<typeof parseContract>[0]) => (input: unknown): SampleVerdict => {
  const read = parseContract(schema, input);
  return read.ok ? { ok: true } : { ok: false, lines: read.issues.map(issue => issue.line) };
};

/** A saved row as project-memory.ts maps its columns. */
const fromRow = (row: (typeof savedRows.decisions.rows)[number]) => ({ id: row.id, repo: row.repo, revision: row.revision, claim: row.claim, why: row.why, status: row.status,
  supersedes: row.supersedes, decidedBy: row.decided_by, decidedAt: row.decided_at, sourceKind: row.source_kind, sourceRef: row.source_ref, recordedBy: row.recorded_by });
const digestOf = (d: Omit<Decision, "id">) => createHash("sha256").update(JSON.stringify([d.repo, d.revision, d.claim, d.why, d.status, d.supersedes, d.decidedBy, d.decidedAt, d.sourceKind, d.sourceRef, d.recordedBy])).digest("hex");

const decision = fromRow(savedRows.decisions.rows[1]!);
const { id: _id, ...record } = decision;

describe("the decision contract", () => {
  it("holds: every saved decision row reads, malformed ones are refused by path", () => {
    expect(savedRows.decisions.rows).toHaveLength(3);
    assertContract({
      schema: decisionSchema,
      read: reader(decisionSchema),
      valid: [
        ...savedRows.decisions.rows.map(row => ({ name: `saved decision ${row.id} (${row.status})`, input: fromRow(row) })),
        // Reading never re-validates length (text-limits.ts).
        { name: "a claim longer than today's limit", input: { ...decision, claim: "c".repeat(TEXT_LIMITS.decisionClaimBytes + 1) } },
      ],
      invalid: [
        { name: "an unknown status", input: { ...decision, status: "paused" }, paths: ["status"] },
        { name: "an unknown source", input: { ...decision, sourceKind: "email" }, paths: ["sourceKind"] },
        { name: "supersedes a decision id or null", input: { ...decision, supersedes: "1" }, paths: ["supersedes"] },
        { name: "an unknown key", input: { ...decision, identity: "x" }, paths: ["payload"] },
        { name: "who decided", input: { ...decision, decidedBy: undefined }, paths: ["decidedBy"] },
      ],
    });
  });

  it("reads a saved row as the same decision, and its digest still verifies it", () => {
    for (const row of savedRows.decisions.rows) {
      const read = decisionSchema.parse(fromRow(row));
      expect(read).toEqual(fromRow(row));
      const { id: _row, ...fields } = read;
      expect(digestOf(fields), `decision ${row.id}`).toBe(row.sha);
    }
  });

  it("holds a new record to its budgets from TEXT_LIMITS", () => {
    const json = toModelSchema(decisionRecordSchema) as { properties: Record<string, { maxLength?: number; anyOf?: { maxLength?: number }[] }> };
    expect(json.properties["claim"]?.maxLength).toBe(TEXT_LIMITS.decisionClaimBytes);
    expect(json.properties["why"]?.maxLength).toBe(TEXT_LIMITS.decisionWhyBytes);
    // The default author is an account name; only an explicitly entered author has the 80-byte limit.
    expect(json.properties["decidedBy"]?.maxLength).toBeUndefined();
    expect(json.properties["sourceRef"]?.anyOf?.[0]?.maxLength).toBe(TEXT_LIMITS.decisionSourceBytes);
    assertContract({
      read: reader(decisionRecordSchema),
      valid: [{ name: "a record", input: record }, { name: "a long default author", input: { ...record, decidedBy: "a".repeat(TEXT_LIMITS.decisionByBytes + 1) } }],
      invalid: [
        { name: "a claim over the limit", input: { ...record, claim: "c".repeat(TEXT_LIMITS.decisionClaimBytes + 1) }, paths: ["claim"] },
        { name: "a reason over the limit", input: { ...record, why: "w".repeat(TEXT_LIMITS.decisionWhyBytes + 1) }, paths: ["why"] },
        { name: "a record has no id", input: decision, paths: ["payload"] },
      ],
    });
  });
});

describe("the decision history contract", () => {
  it("holds: a record or a status reason, versioned; the entries 0.9.36 wrote are the same shapes without it", () => {
    const legacy = savedRows.decisions.changes.map(change => JSON.parse(change.payload) as Record<string, unknown>);
    assertContract({
      schema: decisionChangeSchema,
      read: reader(decisionChangeSchema),
      valid: [
        ...legacy.map((payload, index) => ({ name: `history entry ${index} as version 1`, input: { version: 1, ...payload } })),
        { name: "a retirement", input: { version: 1, reason: "The ledger moved to cash totals." } },
        { name: "a long default author", input: { version: 1, ...record, decidedBy: "a".repeat(TEXT_LIMITS.decisionByBytes + 1) } },
      ],
      invalid: [
        { name: "unversioned", input: legacy[0], paths: ["payload"] },
        { name: "a reason over the limit", input: { version: 1, reason: "r".repeat(TEXT_LIMITS.decisionRetireBytes + 1) }, paths: ["reason"] },
      ],
    });
  });
});
