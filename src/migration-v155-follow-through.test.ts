/** Schema v155 (docs/plans/fleet-follow-through.md): new tables only, and every reader answers over an older database, as a
 * deploy reads with the candidate's code before the migration has run. */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { checkRepairOfRun, checkRepairsOfTask, resumeParkedRepairs, settleCheckRepairs } from "./check-repair.js";
import { evidencePairsOf, failingFirstOf } from "./evidence-pair.js";
import { FINDING_SOURCES, FINDING_SOURCES_BEFORE_LEAD, V155_STEPS, V155_TABLES } from "./fleet-schema.js";
import { sendFinding } from "./findings.js";
import { attachFindings, findingsOfTask, getFinding, settleFindingAnswers, waitingFindings } from "./findings.js";
import { handoverNoteOf } from "./handover-note.js";
import { providerCapture, providerCaptures } from "./provider-capture.js";
import { BUILT_IN, openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, type Store } from "./store.js";

const NOW = new Date("2026-11-07T12:00:00.000Z");
let dir: string | undefined;
const open: Store[] = [];
afterEach(() => { for (const one of open.splice(0)) { try { one.close(); } catch { /* closed */ } } if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });
const fresh = (): Store => { dir ??= mkdtempSync(join(tmpdir(), "so-v155-")); const store = openStore(join(dir, "s.db")); open.push(store); return store; };

describe("v155", () => {
  test("a fresh database has the tables; a v154 one gains them and may update in place", () => {
    const store = fresh();
    expect(SCHEMA_VERSION).toBe(159);
    expect(UPDATE_SAFE_MIGRATIONS).toContain(155);
    expect(V155_STEPS).toEqual(["follow-through-tables", "finding-sources"]);
    store.createTask({ id: "t-1", title: "kept" }, NOW);
    store.close();
    const db = new DatabaseSync(join(dir!, "s.db"));
    for (const table of [...V155_TABLES].reverse()) db.exec(`DROP TABLE ${table}`);
    db.prepare("UPDATE schema_version SET version = 154").run();
    db.close();
    const upgraded = openStore(join(dir!, "s.db"));
    open.push(upgraded);
    expect(upgraded.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(159);
    for (const table of V155_TABLES) expect(upgraded.handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.["n"], table).toBe(0);
    expect(upgraded.getTask("t-1")?.title).toBe("kept");
  });

  // Codex round 2, finding 3: CREATE TABLE IF NOT EXISTS kept the first v155 builds' CHECK, so 'lead' couldn't be saved.
  test("a file from the first v155 builds is widened in place: every finding, id, counter, answer and index kept, and 'lead' saves", () => {
    const store = fresh();
    store.createTask({ id: "t-1", title: "the work" }, NOW);
    for (const summary of ["one", "two", "three"]) sendFinding(store, { taskId: "t-1", source: "person", by: "alex", summary }, NOW);
    store.handle.prepare("INSERT INTO finding_answer (finding, round, run, answer, detail, at) VALUES (1, 1, 7, 'rejected', 'because', ?)").run(NOW.toISOString());
    store.handle.prepare("DELETE FROM finding WHERE id = 3").run();
    store.close();
    // The first builds' table: the same rows under the CHECK without 'lead'.
    const db = new DatabaseSync(join(dir!, "s.db"));
    const sql = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'finding'").get()!["sql"]);
    expect(sql).toContain(FINDING_SOURCES);
    db.exec("PRAGMA foreign_keys = OFF; BEGIN");
    db.exec(sql.replace(FINDING_SOURCES, FINDING_SOURCES_BEFORE_LEAD).replace(/^CREATE TABLE (?:IF NOT EXISTS )?finding/, "CREATE TABLE finding_old"));
    db.exec("INSERT INTO finding_old SELECT * FROM finding; DROP TABLE finding; ALTER TABLE finding_old RENAME TO finding");
    db.exec("CREATE INDEX finding_family ON finding (family_root, state); UPDATE sqlite_sequence SET seq = 3 WHERE name = 'finding'; COMMIT");
    expect(() => db.prepare("UPDATE finding SET source = 'lead' WHERE id = 1").run()).toThrow(/CHECK/);
    db.close();
    const steps: string[] = [];
    const upgraded = openStore(join(dir!, "s.db"), { migrationStep: one => steps.push(one) });
    open.push(upgraded);
    expect(steps).toContain("finding-sources");
    expect(upgraded.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(159);
    expect(String(upgraded.handle.prepare("SELECT sql FROM sqlite_master WHERE name = 'finding'").get()!["sql"])).toContain(FINDING_SOURCES);
    expect(upgraded.handle.prepare("SELECT id, summary FROM finding ORDER BY id").all()).toEqual([{ id: 1, summary: "one" }, { id: 2, summary: "two" }]);
    expect(upgraded.handle.prepare("SELECT finding, detail FROM finding_answer").all()).toEqual([{ finding: 1, detail: "because" }]);
    expect(upgraded.handle.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = 'finding_family'").get()).toEqual({ present: 1 });
    expect(upgraded.handle.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    // The counter is kept: a deleted id is never handed out again. And 'lead' saves.
    const sent = sendFinding(upgraded, { taskId: "t-1", source: "lead", by: "alex", summary: "four" }, NOW);
    expect(sent).toMatchObject({ ok: true, id: 4 });
    // The next open is the fast road: nothing to widen.
    upgraded.close();
    const again: string[] = [];
    open.push(openStore(join(dir!, "s.db"), { migrationStep: one => again.push(one) }));
    expect(again).toEqual([]);
  });

  test("every reader answers over a database that hasn't migrated yet", () => {
    const store = fresh();
    store.createTask({ id: "t-1", title: "the work" }, NOW);
    const ref = store.refFor(BUILT_IN, "t-1").id;
    for (const table of [...V155_TABLES].reverse()) store.handle.exec(`DROP TABLE ${table}`);
    expect(findingsOfTask(store, "t-1")).toEqual([]);
    expect(getFinding(store, 1)).toBeNull();
    expect(waitingFindings(store, null)).toEqual([]);
    expect(attachFindings(store, ref, 1, NOW)).toEqual([]);
    expect(settleFindingAnswers(store, 1, "/nowhere", NOW)).toBe(0);
    expect(checkRepairsOfTask(store, "t-1")).toEqual([]);
    expect(checkRepairOfRun(store, 1)).toBeNull();
    expect(resumeParkedRepairs(store, "/nowhere", NOW)).toBe(0);
    expect(() => settleCheckRepairs(store, "t-1", "verified", NOW)).not.toThrow();
    expect(evidencePairsOf(store, "/nowhere", "t-1", NOW)).toEqual([]);
    expect(failingFirstOf(store, "t-1")).toBeNull();
    expect(providerCaptures(store, null)).toEqual([]);
    expect(providerCapture(store, 1)).toBeNull();
    expect(handoverNoteOf(store, "/nowhere", "t-1", NOW)).toMatchObject({ taskId: "t-1", revision: null, openFindings: [] });
  });
});
