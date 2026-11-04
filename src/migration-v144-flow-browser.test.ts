/** v144 adds only flow_browser_grant: a saved flow keeps its drawing and gets no browser approval. Isolated databases only. */
import { test, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { liveBrowserGrant } from "./flow-browser.js";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS } from "./store.js";
import { changedHistory, historySnapshot } from "./toolroll-update.js";

test.each([143, -143])("v%s: flows survive unchanged and none has browser use approved", version => {
  const dir = mkdtempSync(join(tmpdir(), "toolroll-v144-flow-browser-"));
  const file = join(dir, "state.db"), now = new Date("2026-11-01T00:00:00Z");
  try {
    const first = openStore(file);
    const definitionJson = JSON.stringify({ version: 1, start: "run", stages: [] });
    const flow = first.handle.prepare("INSERT INTO flow (repo, name, definition_json, revision, state, created_by, created_at, updated_by, updated_at) VALUES ('/work/shop', 'Journeys', ?, 3, 'active', 'alex', ?, 'alex', ?)")
      .run(definitionJson, now.toISOString(), now.toISOString()).lastInsertRowid;
    first.close();
    const old = new DatabaseSync(file);
    old.exec("DROP TABLE flow_browser_grant");
    old.prepare("UPDATE schema_version SET version = ?").run(version);
    const before = historySnapshot(old);
    old.close();
    const migrated = openStore(file);
    expect(SCHEMA_VERSION).toBe(147);
    expect(UPDATE_SAFE_MIGRATIONS).toContain(144);
    expect(migrated.handle.prepare("SELECT definition_json, revision FROM flow WHERE id = ?").get(flow)).toMatchObject({ definition_json: definitionJson, revision: 3 });
    expect(liveBrowserGrant(migrated, Number(flow))).toBeNull();
    expect(migrated.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(SCHEMA_VERSION);
    expect(changedHistory(migrated.handle, before)).toEqual([]);
    migrated.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
