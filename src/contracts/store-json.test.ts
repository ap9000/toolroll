import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openStore } from "../store.js";
import { assertContract } from "./contract-test.js";
import { parseStoreColumn, readStoreColumn, readStoreStringifiedList, readStoreTextList, STORE_COLUMNS, storeColumnSchema, type StoreColumn } from "./store-json.js";

/** Saved column texts covering every shape a reader branches on, including ones no writer makes. */
const CORPUS: unknown[] = [
  "[]", '["a","b"]', '["a",1,null,true,{"b":1},["c"],"d"]', "null", "5", '"text"', "true", "{}", '{"label":"x"}',
  '{"a":1,"__proto__":{"x":1},"b":[1,{"c":null}]}', '{"tools":[{"name":"t","digest":"d"}],"skipped":[]}',
  '[{"name":"t","digest":"d"},{"name":1},null,"x"]', "", "not json", "[1,", "undefined", null, undefined, 7,
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

const LIST_COLUMNS = STORE_COLUMNS.filter(column => storeColumnSchema(column).shape.value._zod.def.type === "array");
const CAST_COLUMNS = STORE_COLUMNS.filter(column => storeColumnSchema(column).shape.value._zod.def.type === "unknown");

const verdict = (column: StoreColumn) => (input: unknown) => {
  const read = readStoreColumn(column, input);
  return read.ok ? { ok: true as const } : { ok: false as const, lines: read.issues.map(issue => issue.line) };
};

describe("store JSON columns", () => {
  test("every column is a list, a saved value or a card source", () => {
    expect(LIST_COLUMNS.length + CAST_COLUMNS.length + 1).toBe(STORE_COLUMNS.length);
    expect(STORE_COLUMNS).toContain("flow_card.source_json");
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
    expect(readStoreColumn("run_checkpoint.snapshot_json", '{"version":1}')).toEqual({ ok: true, value: { version: 1 } });
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

  test("writes are byte-identical", () => {
    const dir = mkdtempSync(join(tmpdir(), "store-json-"));
    const file = join(dir, "orders.db");
    try {
      const store = openStore(file);
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
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
