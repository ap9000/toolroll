/** Schema v155 (docs/plans/fleet-follow-through.md): new tables only, and every reader answers over an older database, as a
 * deploy reads with the candidate's code before the migration has run. */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { checkRepairOfRun, checkRepairsOfTask, resumeParkedRepairs, settleCheckRepairs } from "./check-repair.js";
import { evidencePairsOf, failingFirstOf } from "./evidence-pair.js";
import { V155_STEPS, V155_TABLES } from "./fleet-schema.js";
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
    expect(SCHEMA_VERSION).toBe(155);
    expect(UPDATE_SAFE_MIGRATIONS).toContain(155);
    expect(V155_STEPS).toEqual(["follow-through-tables"]);
    store.createTask({ id: "t-1", title: "kept" }, NOW);
    store.close();
    const db = new DatabaseSync(join(dir!, "s.db"));
    for (const table of [...V155_TABLES].reverse()) db.exec(`DROP TABLE ${table}`);
    db.prepare("UPDATE schema_version SET version = 154").run();
    db.close();
    const upgraded = openStore(join(dir!, "s.db"));
    open.push(upgraded);
    expect(upgraded.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(155);
    for (const table of V155_TABLES) expect(upgraded.handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.["n"], table).toBe(0);
    expect(upgraded.getTask("t-1")?.title).toBe("kept");
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
