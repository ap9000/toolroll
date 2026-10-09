/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

test.each([93, -93])("v%s: a subagent's questions carry over whole, and a visit can hold one of its own plus one per ask-first tool call", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v94-"));
  const file = join(dir, "state.db");
  const now = new Date("2026-09-26T10:00:00.000Z");
  const first = openStore(file);
  const flow = first.createFlow({ repo: "/r", name: "Support", definitionJson: JSON.stringify({ version: 1, start: "inbox", stages: [{ id: "inbox", title: "Inbox", kind: "inbox", zone: {}, next: null, onFail: null }] }), by: "alex" }, now);
  const card = first.addFlowCard({ flow, title: "Refund for order 54", description: null, stage: "inbox", by: "alex" }, now);
  const mate = first.createSubagent({ repo: "/r", handle: "maya", soul: "---\nname: Maya\nrole: Support\n---\n## Who you are\nHelpful.\n", model: null, manager: "alex", by: "alex" }, now);
  const question = first.openSubagentQuestion({ subagent: mate, card, entry: 1, question: "Refund all $200?", options: [{ id: "o1", label: "Yes" }], askedOf: "alex" }, now)!;
  first.answerSubagentQuestion(question, { choice: "o1", text: null, by: "alex", via: "web" }, now);
  first.close();
  // The v93 shape: one question per visit, no tools, no receipts.
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`CREATE TABLE subagent_question_old (id INTEGER PRIMARY KEY AUTOINCREMENT, subagent INTEGER NOT NULL REFERENCES subagent(id), card INTEGER NOT NULL REFERENCES flow_card(id), entry INTEGER NOT NULL,
    question TEXT NOT NULL, options_json TEXT NOT NULL, asked_of TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('open','answered','dropped')), choice TEXT, answer TEXT, answered_by TEXT, answered_via TEXT,
    answered_at TEXT, created_at TEXT NOT NULL, UNIQUE (card, entry))`);
  db.exec("INSERT INTO subagent_question_old SELECT id, subagent, card, entry, question, options_json, asked_of, state, choice, answer, answered_by, answered_via, answered_at, created_at FROM subagent_question");
  db.exec("DROP TABLE subagent_question; ALTER TABLE subagent_question_old RENAME TO subagent_question; DROP TABLE subagent_tool; DROP TABLE subagent_call");
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  db.close();
  store = openStore(file);
  expect(SCHEMA_VERSION).toBe(117);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.version).toBe(117);
  expect(store.subagentQuestion(question)).toMatchObject({ state: "answered", question: "Refund all $200?", choice: "o1", toolCall: null });
  // A second question of its own on the same visit is still refused; an approval for a tool call is not.
  expect(store.openSubagentQuestion({ subagent: mate, card, entry: 1, question: "Again?", options: [], askedOf: "alex" }, now)).toBeNull();
  const call = store.addSubagentCall({ subagent: mate, card, entry: 1, tool: "shop", action: "refund_order", input: { order: "54", amount: 200 }, rule: "ask", why: "Over the limit.", state: "asked" }, now);
  const approval = store.openSubagentQuestion({ subagent: mate, card, entry: 1, question: "Use shop → refund_order?", options: [], askedOf: "alex", toolCall: call }, now);
  expect(approval).not.toBeNull();
  expect(store.openSubagentQuestion({ subagent: mate, card, entry: 1, question: "Use it twice?", options: [], askedOf: "alex", toolCall: call }, now)).toBeNull();
  expect(store.openSubagentQuestionOn(card, 1)?.id).toBe(approval);
  expect(store.subagentQuestionFor(card, 1)?.id).toBe(question);
});
