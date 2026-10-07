/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";
import { saveScript, scriptDigest } from "./flow-scripts.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

/** The v84–v89 shape of flow_script: shell only, always a body. */
const V89 = `CREATE TABLE flow_script (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  repo            TEXT NOT NULL,
  name            TEXT NOT NULL,
  about           TEXT NOT NULL,
  body            TEXT NOT NULL,
  timeout_minutes INTEGER NOT NULL,
  version         INTEGER NOT NULL,
  digest          TEXT NOT NULL,
  saved_by        TEXT NOT NULL,
  saved_at        TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('active','removed'))
)`;

test.each([89, -89])("v%s: every script stays a shell script with the same digest, and new ones can be Python, Node or a project file", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v90-"));
  const file = join(dir, "state.db");
  openStore(file).close();
  const db = new DatabaseSync(file);
  db.exec("DROP INDEX IF EXISTS flow_script_live; DROP TABLE flow_script");
  db.exec(V89);
  db.exec("CREATE UNIQUE INDEX flow_script_live ON flow_script (repo, name) WHERE state = 'active'");
  const digest = scriptDigest({ body: "npm test", timeoutMinutes: 15 });
  db.prepare("INSERT INTO flow_script (repo, name, about, body, timeout_minutes, version, digest, saved_by, saved_at, state) VALUES ('/r', 'run-tests', 'Runs the tests', 'npm test', 15, 3, ?, 'alex', '2026-09-20T00:00:00.000Z', 'active')").run(digest);
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  db.close();
  store = openStore(file);
  expect(SCHEMA_VERSION).toBe(111);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.version).toBe(111);
  expect(store.flowScript("/r", "run-tests")).toMatchObject({ language: "shell", file: null, version: 3, digest, body: "npm test" });
  // Saving the same shell script again changes nothing: its digest is the one it had.
  expect(saveScript(store, "/r", { name: "run-tests", about: "Runs the tests", body: "npm test" }, "alex", new Date())).toMatchObject({ ok: true, said: "No changes to save.", version: 3 });
  expect(saveScript(store, "/r", { name: "enrich", about: "Looks leads up", language: "python", file: "scripts/enrich.py" }, "alex", new Date())).toMatchObject({ ok: true });
  store.close(); store = openStore(file);
  expect(store.flowScript("/r", "enrich")).toMatchObject({ language: "python", file: "scripts/enrich.py", body: "" });
});
