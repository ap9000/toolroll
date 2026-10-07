/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

/** The v87–v91 shape of flow_step_run: no teammate turns. */
const V91_STEPS = `CREATE TABLE flow_step_run (
  card INTEGER NOT NULL REFERENCES flow_card(id), entry INTEGER NOT NULL, stage TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('check','update','sort','draft','request','email','tool')),
  script TEXT, script_version INTEGER, state TEXT NOT NULL CHECK (state IN ('running','passed','failed','waiting')), attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT, started_at TEXT NOT NULL, finished_at TEXT, duration_ms INTEGER, exit_code INTEGER, result TEXT, log TEXT, decision_json TEXT,
  PRIMARY KEY (card, entry)
)`;

test.each([91, -91])("v%s: every step run stays as it was, a teammate's turn can be one, and teammates can join", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v92-"));
  const file = join(dir, "state.db");
  const first = openStore(file);
  const flow = first.createFlow({ repo: "/r", name: "Support", definitionJson: JSON.stringify({ version: 1, start: "inbox", stages: [{ id: "inbox", title: "Inbox", kind: "inbox", zone: {}, next: null, onFail: null }] }), by: "alex" }, new Date("2026-09-20T00:00:00.000Z"));
  const card = first.addFlowCard({ flow, title: "Refund for order 51", description: null, stage: "inbox", by: "alex" }, new Date("2026-09-20T00:00:00.000Z"));
  first.close();
  const db = new DatabaseSync(file);
  db.exec("DROP INDEX IF EXISTS flow_step_run_recent; DROP TABLE flow_step_run; DROP INDEX IF EXISTS teammate_live; DROP INDEX IF EXISTS teammate_event_recent; DROP TABLE teammate_question; DROP TABLE teammate_event; DROP TABLE teammate_version; DROP TABLE teammate");
  db.exec(V91_STEPS);
  db.prepare("INSERT INTO flow_step_run (card, entry, stage, kind, state, attempts, started_at, result) VALUES (?, 1, 'send', 'email', 'passed', 1, '2026-09-20T00:00:00.000Z', 'Emailed priya@example.com.')").run(card);
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  db.close();
  store = openStore(file);
  expect(SCHEMA_VERSION).toBe(110);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.version).toBe(110);
  expect(store.flowStepRun(card, 1)).toMatchObject({ kind: "email", state: "passed", result: "Emailed priya@example.com." });
  const now = new Date("2026-09-26T10:00:00.000Z");
  expect(store.claimFlowStep({ card, entry: 2, stage: "decide", kind: "teammate", script: null, scriptVersion: null }, now)).toBe(true);
  const mate = store.createTeammate({ repo: "/r", handle: "maya", soul: "---\nname: Maya\nrole: Support\n---\n## Who you are\nHelpful.\n", model: null, manager: "alex", by: "alex" }, now);
  store.close(); store = openStore(file);
  expect(store.teammateByHandle("/r", "maya")).toMatchObject({ id: mate, state: "active", version: 1, manager: "alex" });
  expect(store.flowStepRun(card, 2)).toMatchObject({ kind: "teammate", state: "running" });
});
