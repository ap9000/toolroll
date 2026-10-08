import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openStore } from "../store.js";
import { assertContract } from "./contract-test.js";
import { parseContract } from "./contract.js";
import { parseStoreColumn, readStoreColumn, readStoreStringifiedList, readStoreTextList, STORE_COLUMNS, STORE_PROJECTIONS, LEGACY_JSON_COLUMNS, storeColumnSchema, type StoreColumn } from "./store-json.js";

/** Saved column texts covering every shape a reader branches on, including ones no writer makes. */
const CORPUS: unknown[] = [
  "[]", '["a","b"]', '["a",1,null,true,{"b":1},["c"],"d"]', "null", "5", '"text"', "true", "{}", '{"label":"x"}',
  '{"a":1,"__proto__":{"x":1},"b":[1,{"c":null}]}', '{"tools":[{"name":"t","digest":"d"}],"skipped":[]}',
  '[{"name":"t","digest":"d"},{"name":1},null,"x"]', "", "not json", "[1,", "undefined", null, undefined, 7,
  '["before",{"toString":null},"after"]', '[{"toString":1,"valueOf":null}]',
];

/** The 0.9.41 readers, as they were written in store.ts before item 18. */
const legacy = {
  textList(value: unknown): string[] {
    try {
      const parsed = JSON.parse(String(value));
      return Array.isArray(parsed) ? parsed.filter((one): one is string => typeof one === "string") : [];
    } catch {
      return [];
    }
  },
  stringified(value: unknown): string[] {
    let out: string[] = [];
    try {
      const parsed = JSON.parse(String(value));
      if (Array.isArray(parsed)) out = parsed.map(one => String(one));
    } catch {
      out = [];
    }
    return out;
  },
  cast(value: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
    try {
      return { ok: true, value: JSON.parse(String(value)) };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  },
  list(value: unknown): unknown[] | null {
    try {
      const parsed = JSON.parse(String(value)) as unknown;
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  },
  cardLabel(value: unknown): string | null {
    if (typeof value !== "string") return null;
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      return typeof parsed["label"] !== "string" ? null : parsed["label"];
    } catch {
      return null;
    }
  },
};

const CAST_COLUMNS = LEGACY_JSON_COLUMNS;
const LIST_COLUMNS = STORE_COLUMNS.filter(column => !CAST_COLUMNS.includes(column) && column !== "flow_card.source_json");

/** Writer-shaped synthetic examples, not exports from the live database. */
const SHAPED_SAMPLES: Partial<Record<StoreColumn, unknown>> = {
  "teammate_suggestion.rule_json": { use: "free", limit: { field: "amount", over: 20, extra: true }, undo: "cancel", extra: 1 },
  "teammate_suggestion.was_json": { use: "ask" },
  "teammate_suggestion.evidence_json": [1, 4],
  "teammate_tool.actions_json": [{ name: "search", about: "Find an item", input: null, readOnly: true, extra: 1 }],
  "teammate_tool.rules_json": { search: { use: "never" } },
  "teammate_question.options_json": [{ id: "yes", label: "Go ahead", extra: 1 }],
  "decision.options": [{ id: "go", label: "Go ahead", consequence: "Create the item", reversible: true, extra: 1 }],
  "attended_authorization.terms_json": { profileJson: null, extra: 1 },
  "operating_mode.terms_json": { dailyRunCap: null, reviewAuto: false, quickMint: true, publication: "automerge", extra: 1 },
  "run_tool.tools_json": { tools: [], skipped: [], fence: { method: "native", paths: 3, extra: true }, extra: 1 },
  "run_tool.tools_json.fence": { method: "native", paths: 3, extra: true },
  "mate_ask.options_json": ["Continue", "Stop"],
  "plan_revision.changed_fields": ["goal", "touches"],
  "run_checkpoint.snapshot_json": { revisionHash: "abc", milestones: [{ id: "m1", state: "completed", note: null, extra: 1 }], extra: 1 },
  "publication_grant.capabilities": ["push-branch", "open-pr"],
  "tournament_terms.agents": [{ provider: "claude", model: "saved-model", repairModel: "inherit", extra: 1 }],
  "task_scope.touches": ["src/example.ts"],
  "task_scope.acceptance_json": [{ id: "c1", statement: "Reads saved data", evidence: ["check"] }],
  "routine.acceptance_json": [],
  "proof_verdict.matrix_json": [{ id: "c1", statement: "Reads saved data", requiredEvidence: ["check"], state: "pass", detail: [], extra: 1 }],
  "teammate_call.input_json": { query: "saved query", nested: { extra: null } },
  "teammate_event.detail_json": { event: "saved", extra: null },
  "coordinator_proposal.payload_json": { task: "t1", queueRevision: 4 },
  "coordinator_proposal.outcome_json": { ok: false, reason: "changed" },
  "mate_proposal.payload_json": { version: 1, operation: "skill_disable", request: { repo: "/repo", version: "abc" }, repo: "/repo", title: "Disable skill", terms: [], stamp: "saved", state: {} },
  "mate_proposal.outcome_json": { ok: true, extra: null },
};

const verdict = (column: StoreColumn) => (input: unknown) => {
  const read = readStoreColumn(column, input);
  return read.ok ? { ok: true as const } : { ok: false as const, lines: read.issues.map(issue => issue.line) };
};

describe("store JSON columns", () => {
  test("the manifest names physical columns; the fence is a separate SQL projection", () => {
    const store = openStore(":memory:");
    try {
      for (const column of STORE_COLUMNS) {
        const [table, field, extra] = column.split(".");
        expect(extra, column).toBeUndefined();
        expect(store.raw().prepare("SELECT name FROM pragma_table_info(?)").all(table).map(row => row["name"]), column).toContain(field);
      }
      expect(STORE_COLUMNS).toEqual(expect.arrayContaining(["teammate_tool.actions_json", "teammate_tool.rules_json", "backend_grant.paths", "backend_grant.mutations"]));
      expect(STORE_COLUMNS).not.toContain("run_tool.tools_json.fence");
      expect(STORE_PROJECTIONS).toEqual(["run_tool.tools_json.fence"]);
      expect(LIST_COLUMNS.length + CAST_COLUMNS.length + 1).toBe(STORE_COLUMNS.length + STORE_PROJECTIONS.length);
    } finally { store.close(); }
  });

  test("known saved shapes have real contracts, preserving unknown keys and historical optionals", () => {
    for (const [column, input] of Object.entries(SHAPED_SAMPLES) as [StoreColumn, unknown][]) {
      const schema = storeColumnSchema(column);
      assertContract({
        schema,
        read: value => {
          const read = parseContract(schema, { version: 1, value });
          return read.ok ? { ok: true } : { ok: false, lines: read.issues.map(issue => issue.line) };
        },
        valid: [{ name: column, input }],
        invalid: [{ name: `${column} wrong shape`, input: true, paths: ["value"] }],
      });
      const read = readStoreColumn(column, JSON.stringify(input));
      expect(read, column).toEqual({ ok: true, value: input });
      expect(JSON.stringify(parseStoreColumn(column, JSON.stringify(input)))).toBe(JSON.stringify(input));
    }
  });

  test("legacy shape issues are named without replacing the old value or turning it into a thrown error", () => {
    const read = readStoreColumn("teammate_suggestion.rule_json", '{"use":"later","limit":null,"extra":1}');
    expect(read).toMatchObject({ ok: true, value: { use: "later", limit: null, extra: 1 }, legacyIssues: [{ path: "use" }, { path: "limit" }] });
    expect(parseStoreColumn("decision.options", "null")).toBeNull();
    expect(parseStoreColumn("teammate_tool.actions_json", '[{"readOnly":"yes"},null]')).toEqual([{ readOnly: "yes" }, null]);
    expect(readStoreColumn("teammate_suggestion.rule_json", "not json")).toMatchObject({ ok: false, malformed: true });
    expect(() => parseStoreColumn("teammate_question.options_json", "not json")).toThrow(SyntaxError);
  });

  test("saved decisions do not acquire write-time length or identifier restrictions", () => {
    const options = [{ id: "legacy id with spaces", label: "x".repeat(10000), consequence: "", reversible: false, future: null }];
    expect(readStoreColumn("decision.options", JSON.stringify(options))).toEqual({ ok: true, value: options });
  });

  test("the v24 touches reader passes non-arrays on, while display readers still filter them", () => {
    for (const value of ["ba", null, {}, 7, ["b", 1, "a"]]) {
      expect(parseStoreColumn("task_scope.touches", JSON.stringify(value))).toEqual(value);
      expect(readStoreTextList("task_scope.touches", JSON.stringify(value))).toEqual(Array.isArray(value) ? ["b", "a"] : []);
    }
  });

  test("the contract holds for each kind of column", () => {
    assertContract({
      schema: storeColumnSchema("lead_config.about_json"),
      read: verdict("lead_config.about_json"),
      valid: [{ name: "a list", input: '["a"]' }, { name: "mixed items", input: '["a",1,null]' }, { name: "empty", input: "[]" }],
      invalid: [{ name: "not a list", input: '{"a":1}', paths: ["payload"] }, { name: "not JSON", input: "[1,", paths: ["payload"] }],
    });
    assertContract({
      read: verdict("flow_card.source_json"),
      valid: [{ name: "a source", input: '{"kind":"github","label":"#1","url":null,"extra":true}' }],
      invalid: [{ name: "no label", input: '{"kind":"x"}', paths: ["label"] }, { name: "null", input: "null", paths: ["payload"] }],
    });
    assertContract({
      read: verdict("mutation.result"),
      valid: CORPUS.filter(raw => legacy.cast(raw).ok).map((input, index) => ({ name: `value ${index}`, input })),
      invalid: [{ name: "not JSON", input: "not json", paths: ["payload"] }],
    });
  });

  test("a saved row is upgraded in memory only: version 0 wraps, a newer envelope never comes from a row", () => {
    // The bare value is never mistaken for the envelope, even when it carries a `version` of its own.
    expect(readStoreColumn("mutation.result", '{"version":9,"a":1}')).toEqual({ ok: true, value: { version: 9, a: 1 } });
    expect(readStoreColumn("run_checkpoint.snapshot_json", '{"version":1}')).toMatchObject({ ok: true, value: { version: 1 } });
  });

  test("text lists read exactly as readJsonArray did", () => {
    for (const column of LIST_COLUMNS) for (const raw of CORPUS) expect(readStoreTextList(column, raw), `${column} ${String(raw)}`).toEqual(legacy.textList(raw));
  });

  test("stringified lists read exactly as reasons and unresolved criteria did", () => {
    for (const column of ["proof_verdict.reasons_json", "repair_chain.unresolved_json", "task_scope.touches"] as const) {
      for (const raw of CORPUS) expect(readStoreStringifiedList(column, raw), `${column} ${String(raw)}`).toEqual(legacy.stringified(raw));
    }
  });

  test("list columns are readable exactly when the old reader found a list, with the same items", () => {
    for (const column of LIST_COLUMNS) {
      for (const raw of CORPUS) {
        const read = readStoreColumn(column, raw), old = legacy.list(raw);
        expect(read.ok ? read.value : null, `${column} ${String(raw)}`).toEqual(old);
        if (!read.ok) expect(read.malformed).toBe(!legacy.cast(raw).ok);
      }
    }
  });

  test("cast columns keep the parsed value exactly, and throw what JSON.parse threw", () => {
    for (const column of CAST_COLUMNS) {
      for (const raw of CORPUS) {
        const old = legacy.cast(raw);
        const read = readStoreColumn(column, raw);
        expect(read.ok).toBe(old.ok);
        if (old.ok) {
          // Nothing copied or stripped: even an own `__proto__` key survives.
          expect(read.ok && read.value).toStrictEqual(old.value);
          expect(JSON.stringify(parseStoreColumn(column, raw))).toBe(JSON.stringify(old.value));
          if (old.value !== null && typeof old.value === "object") expect(Object.keys(read.ok ? read.value as object : {})).toEqual(Object.keys(old.value));
        } else {
          expect(() => parseStoreColumn(column, raw)).toThrow(SyntaxError);
          expect(String((() => { try { parseStoreColumn(column, raw); } catch (error) { return error; } })())).toBe(old.error);
        }
      }
    }
  });

  test("a card source is read when the old reader found a text label", () => {
    for (const raw of CORPUS) {
      const read = readStoreColumn("flow_card.source_json", raw);
      expect(typeof raw === "string" && read.ok ? read.value.label : null, String(raw)).toBe(legacy.cardLabel(raw));
    }
  });

  test("teammate row reads preserve saved bytes, nulls and the old malformed-JSON fallbacks", () => {
    const store = openStore(":memory:");
    try {
      const now = new Date("2026-10-06T12:00:00.000Z");
      const teammate = store.createTeammate({ repo: "/repo", handle: "helper", soul: "Helper", model: null, manager: "owner", by: "owner" }, now);
      const actions = [{ readOnly: true, name: "search", input: null, about: "Find an item", extra: "kept" }];
      const rules = { search: { undo: "cancel", use: "ask" as const, extra: null } };
      store.saveTeammateGrant({ teammate, tool: "catalog", actions, rules }, "owner", now);
      const bytes = () => store.raw().prepare("SELECT actions_json, rules_json FROM teammate_tool WHERE teammate = ?").get(teammate);
      expect(bytes()).toEqual({
        actions_json: '[{"readOnly":true,"name":"search","input":null,"about":"Find an item","extra":"kept"}]',
        rules_json: '{"search":{"undo":"cancel","use":"ask","extra":null}}',
      });
      const written = bytes();
      expect(store.teammateGrant(teammate, "catalog")).toMatchObject({ actions, rules });
      expect(bytes()).toEqual(written);
      store.raw().prepare("UPDATE teammate_tool SET actions_json = 'null', rules_json = 'not json' WHERE teammate = ?").run(teammate);
      expect(store.teammateGrant(teammate, "catalog")).toMatchObject({ actions: null, rules: {} });
      expect(bytes()).toEqual({ actions_json: "null", rules_json: "not json" });

      const suggestion = store.addTeammateSuggestion({ teammate, tool: "catalog", action: "search", rule: { use: "free" }, was: { use: "ask" }, evidence: [1], said: "Allow searches" }, now);
      store.raw().prepare("UPDATE teammate_suggestion SET rule_json = 'null', was_json = 'not json', evidence_json = '7' WHERE id = ?").run(suggestion);
      expect(store.teammateSuggestion(suggestion)).toMatchObject({ rule: null, was: { use: "ask" }, evidence: 7 });
    } finally { store.close(); }
  });

  test("writes are byte-identical", () => {
    const dir = mkdtempSync(join(tmpdir(), "so-store-json-"));
    const file = join(dir, "orders.db");
    try {
      const store = openStore(file);
      try {
        const now = new Date("2026-10-06T12:00:00.000Z");
        store.setLeadAbout("acct", ["likes short answers", "works in \"UTC\""], now);
        store.setApprovalRules("/repo", { notRequester: true, protectProject: false, protectedPaths: ["src/a.ts", "docs/**"] }, "me", now);
        const answer = store.replay({ idempotencyKey: "k1", at: now }, "golden", () => ({ ok: true, at: 1, list: ["x"], nested: { b: null } }));
        expect(store.replay({ idempotencyKey: "k1", at: now }, "golden", () => ({ ok: false }))).toEqual(answer);
        expect(store.leadAbout("acct")).toEqual(["likes short answers", "works in \"UTC\""]);
        expect(store.approvalRules("/repo").protectedPaths).toEqual(["src/a.ts", "docs/**"]);
        const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string, options: { readOnly: boolean }) => { prepare(sql: string): { get(...args: unknown[]): Record<string, unknown> | undefined }; close(): void } };
        const raw = new DatabaseSync(file, { readOnly: true });
        try {
          expect(raw.prepare("SELECT about_json FROM lead_config WHERE account = ?").get("acct")?.["about_json"]).toBe('["likes short answers","works in \\"UTC\\""]');
          expect(raw.prepare("SELECT protected_paths FROM approval_policy WHERE repo = ?").get("/repo")?.["protected_paths"]).toBe('["src/a.ts","docs/**"]');
          expect(raw.prepare("SELECT result FROM mutation WHERE idempotency_key = ?").get("k1")?.["result"]).toBe('{"ok":true,"at":1,"list":["x"],"nested":{"b":null}}');
        } finally {
          raw.close();
        }
      } finally { store.close(); }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
