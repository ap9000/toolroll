/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

test.each([93, -93])("v%s: a teammate's questions carry over whole, and a visit can hold one of its own plus one per ask-first tool call", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v94-"));
  const file = join(dir, "state.db");
  const now = new Date("2026-09-26T10:00:00.000Z");
  const first = openStore(file);
  const flow = first.createFlow({ repo: "/r", name: "Support", definitionJson: JSON.stringify({ version: 1, start: "inbox", stages: [{ id: "inbox", title: "Inbox", kind: "inbox", zone: {}, next: null, onFail: null }] }), by: "alex" }, now);
  const card = first.addFlowCard({ flow, title: "Refund for order 54", description: null, stage: "inbox", by: "alex" }, now);
  const mate = first.createTeammate({ repo: "/r", handle: "maya", soul: "---\nname: Maya\nrole: Support\n---\n## Who you are\nHelpful.\n", model: null, manager: "alex", by: "alex" }, now);
  const question = first.openTeammateQuestion({ teammate: mate, card, entry: 1, question: "Refund all $200?", options: [{ id: "o1", label: "Yes" }], askedOf: "alex" }, now)!;
  first.answerTeammateQuestion(question, { choice: "o1", text: null, by: "alex", via: "web" }, now);
  first.close();
  // The v93 shape: one question per visit, no tools, no receipts.
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`CREATE TABLE teammate_question_old (id INTEGER PRIMARY KEY AUTOINCREMENT, teammate INTEGER NOT NULL REFERENCES teammate(id), card INTEGER NOT NULL REFERENCES flow_card(id), entry INTEGER NOT NULL,
    question TEXT NOT NULL, options_json TEXT NOT NULL, asked_of TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('open','answered','dropped')), choice TEXT, answer TEXT, answered_by TEXT, answered_via TEXT,
    answered_at TEXT, created_at TEXT NOT NULL, UNIQUE (card, entry))`);
  db.exec("INSERT INTO teammate_question_old SELECT id, teammate, card, entry, question, options_json, asked_of, state, choice, answer, answered_by, answered_via, answered_at, created_at FROM teammate_question");
  db.exec("DROP TABLE teammate_question; ALTER TABLE teammate_question_old RENAME TO teammate_question; DROP TABLE teammate_tool; DROP TABLE teammate_call");
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  db.close();
  store = openStore(file);
  expect(SCHEMA_VERSION).toBe(110);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.version).toBe(110);
  expect(store.teammateQuestion(question)).toMatchObject({ state: "answered", question: "Refund all $200?", choice: "o1", toolCall: null });
  // A second question of its own on the same visit is still refused; an approval for a tool call is not.
  expect(store.openTeammateQuestion({ teammate: mate, card, entry: 1, question: "Again?", options: [], askedOf: "alex" }, now)).toBeNull();
  const call = store.addTeammateCall({ teammate: mate, card, entry: 1, tool: "shop", action: "refund_order", input: { order: "54", amount: 200 }, rule: "ask", why: "Over the limit.", state: "asked" }, now);
  const approval = store.openTeammateQuestion({ teammate: mate, card, entry: 1, question: "Use shop → refund_order?", options: [], askedOf: "alex", toolCall: call }, now);
  expect(approval).not.toBeNull();
  expect(store.openTeammateQuestion({ teammate: mate, card, entry: 1, question: "Use it twice?", options: [], askedOf: "alex", toolCall: call }, now)).toBeNull();
  expect(store.openTeammateQuestionOn(card, 1)?.id).toBe(approval);
  expect(store.teammateQuestionFor(card, 1)?.id).toBe(question);
});
