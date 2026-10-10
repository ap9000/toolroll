/**
 * v117 (D5): one AI concept, the lead. A v116 file — the mate's tables (mate_*) and the teammates' (teammate*), their
 * rows' teammate column, and the internal kinds that said 'teammate' — upgrades whole: every row, id and link under
 * the lead's and the subagents' names, each subagent's name, personality and rules readable as before, a flow step
 * that named a teammate read as a subagent step, the update rehearsal satisfied, and a second open a no-op.
 * Isolated fixtures only: production databases are never opened here.
 */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, orphanKey, SCHEMA_VERSION, V117_RENAMED_COLUMNS, V117_RENAMED_TABLES, type Store } from "./store.js";
import { changedHistory, historySnapshot } from "./toolroll-update.js";
import { flowDefinitionOf } from "./flow-engine.js";
import { parseSoul } from "./subagents.js";

const NOW = new Date("2026-10-09T10:00:00.000Z");
const SOUL = "---\nname: Rosa\nrole: Support\n---\n\n## Who you are\nWarm, calm and quick.\n\n## Decide on your own\n- Refunds up to $50.\n\n## Ask first\n- Refunds over $50.\n\n## Never\n- Promise dates.\n";
const SOUL_V2 = SOUL.replace("Refunds up to $50.", "Refunds up to $100.");
const OLD_NAME = Object.fromEntries(Object.entries(V117_RENAMED_TABLES).map(([old, now]) => [now, old]));

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

type Seeded = { subagent: number; thread: number; card: number; flow: number; legacyFlow: number; proposal: number; session: number };

/** A current file with the lead and a subagent at work: a conversation, a proposal, an ask, and a subagent's history. */
function seed(file: string): Seeded {
  const s = openStore(file);
  try {
    const session = s.mintLeadSession({ approver: "alex", approverGeneration: 1, credentialKey: "k", ceilingMicrousd: 5_000_000, ceilingDigest: "c", termsDigest: "t".repeat(64) }, NOW);
    const { thread } = s.openLeadThread("alex", "c", NOW);
    s.appendLeadMessage({ thread: thread.id, turn: null, role: "operator", text: "Ask Rosa to draft the refund reply." }, NOW);
    const turn = s.handle.prepare(`INSERT INTO mate_turn (session, thread, approver, generation, credential_key, state, reserved_microusd, created_at, deadline_at)
      VALUES (?, ?, 'alex', 1, 'k', 'answered', 10, ?, ?)`).run(session, thread.id, NOW.toISOString(), NOW.toISOString()).lastInsertRowid;
    s.appendLeadMessage({ thread: thread.id, turn: Number(turn), role: "assistant", text: "Rosa has it." }, NOW);
    const proposal = s.draftLeadProposal({ thread: thread.id, turn: Number(turn), kind: "action", payload: { operation: "subagent_ask", note: "kept" }, ceilingDigest: "c" }, NOW);
    s.recordLeadAsk({ turn: Number(turn), thread: thread.id, question: "Which order?", options: ["2201", "2202"] }, NOW);

    const flow = s.createFlow({ repo: "/r", name: "Support", definitionJson: JSON.stringify({ version: 1, start: "inbox", stages: [{ id: "inbox", title: "Inbox", kind: "inbox", zone: {}, next: null, onFail: null }] }), by: "alex" }, NOW);
    const card = s.addFlowCard({ flow, title: "Refund for order 2201", description: null, stage: "inbox", by: "alex" }, NOW);
    const subagent = s.createSubagent({ repo: "/r", handle: "rosa", soul: SOUL, model: null, manager: "alex", by: "alex" }, NOW);
    s.saveSubagentSoul(subagent, SOUL_V2, "alex", NOW);
    s.addSubagentEvent({ subagent, card, entry: 1, kind: "handled", said: "Rosa drafted the reply.", by: "Rosa (AI)" }, NOW);
    s.addSubagentMemory({ subagent, text: "Order 2201 shipped late.", source: "subagent", card, by: "Rosa (AI)" }, NOW);
    s.addSubagentMemory({ subagent, text: "Offer free shipping this week.", source: "person", by: "alex" }, NOW);
    s.saveSubagentGrant({ subagent, tool: "shop", actions: [{ name: "refund_order", about: "", readOnly: false, input: {} }] as never, rules: { refund_order: { use: "ask" } } }, "alex", NOW);
    const call = s.addSubagentCall({ subagent, card, entry: 1, tool: "shop", action: "refund_order", input: { order: "2201" }, rule: "ask", why: "Over its limit.", state: "asked" }, NOW);
    s.openSubagentQuestion({ subagent, card, entry: 1, question: "Refund $80?", options: [{ id: "approve", label: "Approve" }], askedOf: "alex", toolCall: call }, NOW);
    s.addSubagentSuggestion({ subagent, tool: "shop", action: "refund_order", rule: { use: "free" }, was: { use: "ask" }, evidence: [call], said: "May I?" }, NOW);
    s.addSubagentTurn({ subagent, card, model: "default", ok: true, ms: 900, costUsd: 0.01 }, NOW);
    s.setBudget({ scope: "subagent", key: String(subagent), limitMicrousd: 1_000_000, hardStop: true }, "alex", NOW);
    s.handle.prepare("INSERT INTO flow_step_run (card, entry, stage, kind, state, started_at) VALUES (?, 1, 'answer', 'subagent', 'passed', ?)").run(card, NOW.toISOString());
    s.handle.prepare("UPDATE task_ref SET filed_by_kind = 'subagent' WHERE 0").run();
    // A flow drawn before D5: its step says "teammate", naming the teammate.
    const legacyFlow = s.createFlow({ repo: "/r", name: "Desk", definitionJson: JSON.stringify({ version: 1, start: "answer", stages: [
      { id: "answer", title: "Rosa answers", kind: "subagent", zone: {}, instructions: "Answer the customer.", subagent: "rosa", routes: [{ answer: "Done", to: "done" }], next: "done", onFail: null },
      { id: "done", title: "Done", kind: "done", zone: {}, next: null, onFail: null }] }), by: "alex" }, NOW);
    return { subagent, thread: thread.id, card, flow, legacyFlow, proposal, session };
  } finally { s.close(); }
}

/** The same file as v116 wrote it: old table, column and index names, 'teammate' in its CHECKs and rows. */
function toV116(file: string, legacyFlow: number): void {
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA foreign_keys = OFF");
    for (const [table, from, to] of V117_RENAMED_COLUMNS) db.exec(`ALTER TABLE "${table}" RENAME COLUMN "${to}" TO "${from}"`);
    for (const [old, now] of Object.entries(V117_RENAMED_TABLES)) db.exec(`ALTER TABLE "${now}" RENAME TO "${old}"`);
    const indexes = db.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").all() as { name: string; tbl_name: string; sql: string }[];
    for (const index of indexes.filter(one => Object.keys(V117_RENAMED_TABLES).includes(one.tbl_name))) {
      const old = index.name.replace(/^lead_/, "mate_").replace(/^subagent(?=_|$)/, "teammate");
      if (old === index.name) continue;
      db.exec(`DROP INDEX "${index.name}"`);
      db.exec(index.sql.replace(index.name, old));
    }
    const version = Number(db.prepare("PRAGMA schema_version").get()!["schema_version"]);
    (db as unknown as { enableDefensive?: (on: boolean) => void }).enableDefensive?.(false);
    db.exec("PRAGMA writable_schema = ON");
    for (const table of ["flow_step_run", "budget", "teammate_memory"]) db.prepare("UPDATE sqlite_master SET sql = replace(sql, ?, ?) WHERE type = 'table' AND name = ?").run("'subagent'", "'teammate'", table);
    db.exec(`PRAGMA schema_version = ${version + 1}`);
    db.exec("PRAGMA writable_schema = OFF");
    db.exec("UPDATE flow_step_run SET kind = 'teammate' WHERE kind = 'subagent'; UPDATE budget SET scope_kind = 'teammate' WHERE scope_kind = 'subagent'; UPDATE teammate_memory SET source = 'teammate' WHERE source = 'subagent'");
    const definition = JSON.parse(String(db.prepare("SELECT definition_json FROM flow WHERE id = ?").get(legacyFlow)!["definition_json"])) as { stages: Record<string, unknown>[] };
    definition.stages[0] = { ...Object.fromEntries(Object.entries(definition.stages[0]!).filter(([key]) => key !== "subagent")), kind: "teammate", teammate: "rosa" };
    db.prepare("UPDATE flow SET definition_json = ? WHERE id = ?").run(JSON.stringify(definition), legacyFlow);
    db.prepare("UPDATE schema_version SET version = 116").run();
    expect(db.prepare("PRAGMA integrity_check").get()!["integrity_check"]).toBe("ok");
  } finally { db.close(); }
}

const rows = (db: DatabaseSync, table: string) => db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all().map(row => ({ ...row }));
const names = (db: DatabaseSync, type: "table" | "index") => (db.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name").all(type) as { name: string }[]).map(one => one.name);

describe("v117: the mate's tables become the lead's, and teammates the lead's subagents", () => {
  test("a populated v116 file upgrades whole: every row and link renamed, personalities and rules intact, legacy flow steps read as subagent steps", () => {
    dir = mkdtempSync(join(tmpdir(), "so-v117-"));
    const file = join(dir, "state.db"), fresh = join(dir, "fresh.db");
    const seeded = seed(file);
    toV116(file, seeded.legacyFlow);

    const old = new DatabaseSync(file, { readOnly: true });
    const before = Object.fromEntries(Object.keys(V117_RENAMED_TABLES).map(table => [table, rows(old, table)]));
    const kinds = { steps: rows(old, "flow_step_run").length, budgets: rows(old, "budget").length };
    const history = historySnapshot(old);
    expect(names(old, "table")).toEqual(expect.arrayContaining(["mate_session", "teammate", "teammate_memory"]));
    old.close();

    store = openStore(file);
    expect(SCHEMA_VERSION).toBe(118);
    expect(store.handle.prepare("SELECT version FROM schema_version").get()!["version"]).toBe(118);
    // Each subagent keeps its name, personality and rules, and its history; its own kinds now say subagent.
    const rosa = store.getSubagent(seeded.subagent)!;
    expect(rosa).toMatchObject({ handle: "rosa", soul: SOUL_V2, version: 2, state: "active", manager: "alex" });
    const soul = parseSoul(rosa.soul);
    expect(soul.ok && soul.soul.name).toBe("Rosa");
    expect(soul.ok && soul.soul.sections.map(one => one.title)).toEqual(["Who you are", "Decide on your own", "Ask first", "Never"]);
    expect(store.subagentVersions(seeded.subagent).map(one => one.soul)).toEqual([SOUL_V2, SOUL]);
    expect(store.subagentMemories(seeded.subagent).map(one => [one.source, one.text])).toEqual(expect.arrayContaining([["subagent", "Order 2201 shipped late."], ["person", "Offer free shipping this week."]]));
    expect(store.subagentGrants(seeded.subagent)[0]).toMatchObject({ tool: "shop", rules: { refund_order: { use: "ask" } } });
    expect(store.openSubagentQuestions([seeded.subagent]).map(one => one.question)).toEqual(["Refund $80?"]);
    expect(store.handle.prepare("SELECT kind FROM flow_step_run").all().map(row => row["kind"])).toEqual(["subagent"]);
    expect(store.handle.prepare("SELECT scope_kind FROM budget").all().map(row => row["scope_kind"])).toEqual(["subagent"]);
    // The lead's conversation, proposal and ask carry over by id.
    expect(store.listLeadMessages(seeded.thread, 10).map(one => one.text)).toEqual(expect.arrayContaining(["Ask Rosa to draft the refund reply.", "Rosa has it."]));
    expect(store.getLeadProposal(seeded.proposal)).toMatchObject({ thread: seeded.thread, kind: "action", payload: { operation: "subagent_ask", note: "kept" } });
    expect(store.getLeadSession(seeded.session)).toMatchObject({ approver: "alex" });
    // A flow step drawn as a teammate's is a subagent step naming it.
    expect(flowDefinitionOf(store.getFlow(seeded.legacyFlow)!)!.stages[0]).toMatchObject({ kind: "subagent", subagent: "rosa" });
    store.close(); store = undefined;

    // Every row arrived under its new name with the same values (the renamed column under its own), with no orphan and
    // no old name left; the shape matches a fresh file's; the update rehearsal sees nothing changed beyond its rules.
    openStore(fresh).close();
    const db = new DatabaseSync(file, { readOnly: true }), clean = new DatabaseSync(fresh, { readOnly: true });
    try {
      for (const [table, kept] of Object.entries(before)) {
        const now = V117_RENAMED_TABLES[table]!;
        const renamed = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key === "teammate" ? "subagent" : key, key === "source" && value === "teammate" ? "subagent" : value]));
        expect(rows(db, now), table).toEqual(kept.map(renamed));
      }
      expect(rows(db, "flow_step_run")).toHaveLength(kinds.steps);
      expect(rows(db, "budget")).toHaveLength(kinds.budgets);
      expect(names(db, "table").filter(name => /^(mate_(?!turn$)|teammate)/.test(name))).toEqual([]);
      expect(names(db, "index").filter(name => /^(mate_(?!turn_)|teammate)/.test(name))).toEqual([]);
      expect(names(db, "table")).toEqual(names(clean, "table"));
      expect(names(db, "index")).toEqual(names(clean, "index"));
      for (const table of Object.values(V117_RENAMED_TABLES)) {
        expect(db.prepare(`PRAGMA table_info("${table}")`).all().map(row => row["name"]), table).toEqual(clean.prepare(`PRAGMA table_info("${table}")`).all().map(row => row["name"]));
      }
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("PRAGMA integrity_check").get()!["integrity_check"]).toBe("ok");
      expect(changedHistory(db, history)).toEqual([]);
    } finally { db.close(); clean.close(); }

    // A second open changes nothing.
    const once = readFileSync(file);
    openStore(file).close();
    const twice = new DatabaseSync(file, { readOnly: true });
    try { expect(Object.keys(V117_RENAMED_TABLES).every(table => rows(twice, V117_RENAMED_TABLES[table]!).length === before[table]!.length)).toBe(true); } finally { twice.close(); }
    expect(once.length).toBeGreaterThan(0);
  });

  test("a row already pointing nowhere before the upgrade is the install's own: the renames carry it, and nothing new points nowhere", () => {
    dir = mkdtempSync(join(tmpdir(), "so-v117-"));
    const file = join(dir, "state.db");
    const seeded = seed(file);
    toV116(file, seeded.legacyFlow);
    const db = new DatabaseSync(file);
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("INSERT INTO teammate_event (teammate, kind, said, at) VALUES (9999, 'note', 'From a teammate removed by hand.', ?)").run(NOW.toISOString());
    const before = db.prepare("PRAGMA foreign_key_check").all().map(orphanKey);
    db.close();
    expect(before).toHaveLength(1);
    store = openStore(file);
    expect(store.handle.prepare("SELECT version FROM schema_version").get()!["version"]).toBe(118);
    const after = store.handle.prepare("PRAGMA foreign_key_check").all();
    expect(after).toMatchObject([{ table: "subagent_event", parent: "subagent" }]);
    expect(after.map(orphanKey)).toEqual(before);
  });

  test("a file that holds a renamed table under both names is refused before anything changes", () => {
    dir = mkdtempSync(join(tmpdir(), "so-v117-"));
    const file = join(dir, "state.db");
    const seeded = seed(file);
    toV116(file, seeded.legacyFlow);
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE lead_session (id INTEGER PRIMARY KEY)");
    db.close();
    const before = readFileSync(file);
    expect(() => openStore(file)).toThrow(/both mate_session and lead_session are here; refusing to merge them/);
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  test("the old names are only the ones this build keeps on purpose", () => {
    // mate_turn (and chat_turn.mate_turn) keep their names this release: the previous updater lifts its gate by them.
    expect(Object.keys(V117_RENAMED_TABLES)).not.toContain("mate_turn");
    expect(OLD_NAME["lead_session"]).toBe("mate_session");
    expect(OLD_NAME["subagent"]).toBe("teammate");
  });
});
