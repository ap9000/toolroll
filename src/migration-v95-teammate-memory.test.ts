/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

test.each([94, -94])("v%s: what people told a teammate becomes its memory, once; a suggestion can be asked beside the visit's own question", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v95-"));
  const file = join(dir, "state.db");
  const now = new Date("2026-09-26T10:00:00.000Z");
  const first = openStore(file);
  const flow = first.createFlow({ repo: "/r", name: "Support", definitionJson: JSON.stringify({ version: 1, start: "inbox", stages: [{ id: "inbox", title: "Inbox", kind: "inbox", zone: {}, next: null, onFail: null }] }), by: "alex" }, now);
  const card = first.addFlowCard({ flow, title: "Refund for order 54", description: null, stage: "inbox", by: "alex" }, now);
  const mate = first.createTeammate({ repo: "/r", handle: "maya", soul: "---\nname: Maya\nrole: Support\n---\n## Who you are\nHelpful.\n", model: null, manager: "alex", by: "alex" }, now);
  first.addTeammateEvent({ teammate: mate, kind: "note", said: "alex brought Maya onto the team.", by: "alex" }, now);
  first.addTeammateEvent({ teammate: mate, kind: "note", said: "This week, offer free shipping instead of refunds.", by: "alex" }, new Date(now.getTime() + 1000));
  first.close();
  // The v94 shape: no memory, no suggestions, and the visit's own question unique among questions with no tool call.
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("DROP TABLE teammate_memory; DROP TABLE teammate_suggestion; DROP INDEX teammate_question_visit; DROP INDEX teammate_question_suggestion");
  db.exec(`CREATE TABLE teammate_question_old (id INTEGER PRIMARY KEY AUTOINCREMENT, teammate INTEGER NOT NULL REFERENCES teammate(id), card INTEGER NOT NULL REFERENCES flow_card(id), entry INTEGER NOT NULL,
    question TEXT NOT NULL, options_json TEXT NOT NULL, asked_of TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('open','answered','dropped')), choice TEXT, answer TEXT, answered_by TEXT, answered_via TEXT,
    answered_at TEXT, created_at TEXT NOT NULL, tool_call     INTEGER REFERENCES teammate_call(id))`);
  db.exec("DROP TABLE teammate_question; ALTER TABLE teammate_question_old RENAME TO teammate_question");
  db.exec("CREATE UNIQUE INDEX teammate_question_visit ON teammate_question (card, entry) WHERE tool_call IS NULL");
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  db.close();
  store = openStore(file);
  expect(SCHEMA_VERSION).toBe(113);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.version).toBe(113);
  expect(store.teammateMemories(mate).map(one => [one.source, one.text, one.createdBy, one.createdAt])).toEqual([["person", "This week, offer free shipping instead of refunds.", "alex", "2026-09-26T10:00:01.000Z"]]);
  store.close();
  store = openStore(file);
  expect(store.teammateMemories(mate)).toHaveLength(1);
  const own = store.openTeammateQuestion({ teammate: mate, card, entry: 1, question: "Refund all of it?", options: [], askedOf: "alex" }, now);
  const suggestion = store.addTeammateSuggestion({ teammate: mate, tool: "shop", action: "refund_order", rule: { use: "free" }, was: { use: "ask" }, evidence: [], said: "May I?" }, now);
  const offered = store.openTeammateQuestion({ teammate: mate, card, entry: 1, question: "May I?", options: [], askedOf: "alex", suggestion }, now);
  expect(own).not.toBeNull();
  expect(offered).not.toBeNull();
  expect(store.openTeammateQuestion({ teammate: mate, card, entry: 1, question: "Again?", options: [], askedOf: "alex" }, now)).toBeNull();
  expect(store.openTeammateQuestionOn(card, 1)?.id).toBe(own);
});
