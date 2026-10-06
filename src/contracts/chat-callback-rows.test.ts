import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import type { ContractResult } from "./contract.js";
import { decideActionRowSchema, proposalActionRowSchema, readDecideActionRow, readProposalActionRow } from "./chat-callback-rows.js";

type Row = { name: string; row: Record<string, unknown> };
const rows = (JSON.parse(readFileSync(new URL("../../test/fixtures/chat/channel-callbacks.json", import.meta.url), "utf8")) as { rows: { proposal: Row[]; decide: Row[] } }).rows;
const verdict = <T>(read: ContractResult<T>): SampleVerdict => (read.ok ? { ok: true } : { ok: false, lines: read.issues.map(issue => issue.line) });

describe("a saved chat button", () => {
  it("a proposal card's button holds: round trip, saved rows read as they are, a damaged one refused by column", () => {
    const one = rows.proposal[0]!.row;
    assertContract({
      schema: proposalActionRowSchema,
      read: input => verdict(readProposalActionRow(input)),
      valid: rows.proposal.map(row => ({ name: row.name, input: row.row })),
      invalid: [
        { name: "an unknown phase", input: { ...one, phase: "approve" }, paths: ["phase"] },
        { name: "a proposal id", input: { ...one, proposal: "17" }, paths: ["proposal"] },
        { name: "a column it doesn't have", input: { ...one, payload: "{}" }, paths: ["payload"] },
      ],
    });
    for (const row of rows.proposal) expect(readProposalActionRow(row.row)).toEqual({ ok: true, value: row.row });
  });

  it("a decide button holds: round trip, saved rows read as they are, a damaged one refused by column", () => {
    const one = rows.decide[0]!.row;
    assertContract({
      schema: decideActionRowSchema,
      read: input => verdict(readDecideActionRow(input)),
      valid: rows.decide.map(row => ({ name: row.name, input: row.row })),
      invalid: [
        { name: "an act it doesn't do", input: { ...one, act: "deploy" }, paths: ["act"] },
        { name: "not a decide token", input: { ...one, token: "0123456789abcdef0123456789abcdef" }, paths: ["token"] },
        { name: "no task", input: { ...one, task_id: null }, paths: ["task_id"] },
      ],
    });
    for (const row of rows.decide) expect(readDecideActionRow(row.row)).toEqual({ ok: true, value: row.row });
  });
});
