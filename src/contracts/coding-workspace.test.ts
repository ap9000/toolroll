import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import { codingSessionDocument, codingSessionRecordSchema, parseCodingSessionDocument, readCodingSessionRecord, type CodingSession } from "./coding-workspace.js";
import { savedSessionRows } from "../../test/coding-fixtures.js";

const read = (input: unknown): SampleVerdict => {
  const parsed = readCodingSessionRecord(input);
  return parsed.ok ? { ok: true } : { ok: false, lines: parsed.issues.map(issue => issue.line) };
};

const legacy = savedSessionRows.map(row => JSON.parse(row.document) as Record<string, unknown>);
const [withContext, closed] = legacy as [Record<string, unknown>, Record<string, unknown>];
/** What the old reader made of a saved document, with the capture inside it now carrying its version. */
const asRead = (document: Record<string, unknown>): CodingSession => {
  const context = document["context"] as Record<string, unknown> | undefined;
  return { ...document, ...(context === undefined ? {} : { context: { version: 1, ...context } }) } as CodingSession;
};
const current = { version: 1, ...asRead(withContext) };

describe("the coding workspace record contract", () => {
  it("holds: the JSON Schema round trip loses nothing, saved and current records read, malformed ones are refused by path", () => {
    assertContract({
      schema: codingSessionRecordSchema,
      read,
      valid: [
        ...legacy.map((input, index) => ({ name: `saved by 0.9.36: ${savedSessionRows[index]!.id}`, input })),
        { name: "saved before startup finished, no context or receipt fields", input: (({ context: _c, initialRequest: _r, ...rest }) => ({ ...rest, status: "starting", nativeThreadId: null }))(withContext) },
        { name: "saved with a field the old reader ignored", input: { ...closed, retired: "x" } },
        { name: "current version 1", input: current },
      ],
      invalid: [
        { name: "newer version", input: { ...current, version: 2 }, paths: ["version"] },
        { name: "version 1 is strict", input: { ...current, retired: "x" }, paths: ["payload"] },
        { name: "unknown status", input: { ...closed, status: "paused" }, paths: ["status"] },
        { name: "only Codex sessions", input: { ...closed, provider: "claude" }, paths: ["provider"] },
        { name: "missing worktree", input: { ...closed, worktree: undefined }, paths: ["worktree"] },
        { name: "initial request names its prompt", input: { ...closed, initialRequest: { requestId: "initial-request-0002" } }, paths: ["initialRequest.prompt"] },
        { name: "a version 1 record carries a version 1 context", input: { ...current, context: (withContext as { context: unknown }).context }, paths: ["context.version"] },
        { name: "the saved context is checked too", input: { ...withContext, context: { ...(withContext["context"] as object), sha256: null } }, paths: ["context.sha256"] },
      ],
    });
  });

  it("reads every saved row as the old reader did, and writes it back as version 1 that reads the same", () => {
    for (const [index, row] of savedSessionRows.entries()) {
      const session = parseCodingSessionDocument(row.document);
      expect(session, row.id).toEqual(asRead(legacy[index]!));
      const written = codingSessionDocument(session);
      expect(JSON.parse(written), row.id).toMatchObject({ version: 1 });
      expect(parseCodingSessionDocument(written), row.id).toEqual(session);
    }
  });

  it("refuses an unreadable document with its path", () => {
    expect(() => parseCodingSessionDocument("{")).toThrow("A saved coding session could not be read: payload: not JSON");
    expect(() => parseCodingSessionDocument(JSON.stringify("unreadable"))).toThrow("payload: must be an object");
    expect(() => parseCodingSessionDocument(JSON.stringify({ ...current, version: 2 }))).toThrow("version: made by a newer Toolroll");
  });
});

describe("the Zod revamp plan", () => {
  it("marks item 12 done in the wave 2 table and records it under Done", () => {
    const plan = readFileSync(new URL("../../docs/plans/zod-revamp.md", import.meta.url), "utf8");
    expect(plan).toMatch(/^\| 12 ✅ \| \*\*Coding handoff and context\*\*/m);
    const done = plan.slice(plan.indexOf("\n## Done\n"));
    expect(done).toMatch(/^- \*\*12\. Coding handoff and context\*\* \(2026-10-0\d\)\./m);
  });
});
