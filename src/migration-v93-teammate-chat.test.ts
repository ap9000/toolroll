/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { windChatsBack } from "../test/legacy-chat.js";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

test.each([92, -92])("v%s: a teammate's open question stays open, and it can be answered from a chat app", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v93-"));
  const file = join(dir, "state.db");
  const now = new Date("2026-09-26T10:00:00.000Z");
  const first = openStore(file);
  const flow = first.createFlow({ repo: "/r", name: "Support", definitionJson: JSON.stringify({ version: 1, start: "inbox", stages: [{ id: "inbox", title: "Inbox", kind: "inbox", zone: {}, next: null, onFail: null }] }), by: "alex" }, now);
  const card = first.addFlowCard({ flow, title: "Refund for order 54", description: null, stage: "inbox", by: "alex" }, now);
  const mate = first.createTeammate({ repo: "/r", handle: "maya", soul: "---\nname: Maya\nrole: Support\n---\n## Who you are\nHelpful.\n", model: null, manager: "alex", by: "alex" }, now);
  const question = first.openTeammateQuestion({ teammate: mate, card, entry: 1, question: "Refund all $200?", options: [{ id: "o1", label: "Yes" }], askedOf: "alex" }, now)!;
  first.close();
  // The v92 shape: no chat-app answers.
  const db = new DatabaseSync(file);
  windChatsBack(db);
  for (const table of ["telegram_question_action", "telegram_question_prompt", ...["slack", "discord", "teams"].flatMap(app => [`${app}_question_action`, `${app}_question_prompt`])]) db.exec(`DROP TABLE ${table}`);
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  db.close();
  store = openStore(file);
  expect(SCHEMA_VERSION).toBe(116);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.version).toBe(116);
  expect(store.teammateQuestion(question)).toMatchObject({ state: "open", question: "Refund all $200?", askedOf: "alex" });
  // Every chat app answers it through the shared chat tables (v114).
  for (const table of ["chat_question_action", "chat_question_prompt"]) {
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.n).toBe(1);
  }
  for (const table of ["telegram_question_action", "telegram_question_prompt", "slack_question_action", "discord_question_prompt", "teams_question_action"]) {
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.n).toBe(0);
  }
});
