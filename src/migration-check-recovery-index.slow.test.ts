/** Actual v177 -> v178 catalog/history/epoch and query-plan contracts; no large benchmark. */
import { afterAll, afterEach, expect, test } from "vitest";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS } from "./store.js";
import { addApprover, propose, approve } from "./scope.js";
import { mintApiToken } from "./api-tokens.js";
import { FINDING_SOURCES, FINDING_SOURCES_BEFORE_LEAD } from "./fleet-schema.js";
import { V177_SCHEMA } from "./workspace-identity-schema.js";
import { V178_INDEX, V178_SCHEMA } from "./check-recovery-index-schema.js";
import { CHECK_RECOVERY_HELD } from "./check-recovery-hold.js";
const dirs: string[] = [], now = new Date("2026-11-20T00:00:00Z");
let template177: { dir: string; file: string } | null = null;
afterEach(() => { for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true }); });
afterAll(() => { if (template177 !== null) { rmSync(template177.dir, { recursive: true, force: true }); template177 = null; } });
function source177(): string {
  if (template177 === null) {
    const baseDir = mkdtempSync(join(tmpdir(), "so-index-178-tpl-"));
    const baseFile = join(baseDir, "orders.db"), s = openStore(baseFile);
    s.createTask({ id: "kept", title: "Keep history" }, now);
    const who = addApprover(s, "synthetic", now); if (!who.ok) throw Error("fixture");
    for (const phase of ["build", "plan", "review"] as const) s.setPhaseConfig("installation", phase, "codex", "gpt-5-codex", "synthetic", now);
    s.placeTask(s.refFor("built-in", "kept").id, baseDir, {}, now);
    const proposed = propose(s, { taskId: "kept", goal: "Keep this exact approval", touches: ["."], acceptance: [{ id: "c1", statement: "Preserve history", how: null, evidence: ["check"] }], now });
    const approved = approve(s, "kept", "synthetic", now, proposed.digest, who.token);
    if (!approved.ok) throw Error(`fixture approval: ${approved.reason}`);
    const token = mintApiToken();
    s.createApiToken({ id: token.id, account: "synthetic", name: "preserve", secretHash: token.hash, access: "read", expiresAt: "2027-11-20T00:00:00.000Z", by: "synthetic", projects: null, purpose: "api" }, now);
    s.close(); const db = new DatabaseSync(baseFile);
    db.exec(`DROP INDEX ${V178_INDEX}; UPDATE schema_version SET version=177`); db.close();
    template177 = { dir: baseDir, file: baseFile };
  }
  const folder = mkdtempSync(join(tmpdir(), "so-index-178-")); dirs.push(folder);
  const file = join(folder, "orders.db");
  copyFileSync(template177.file, file);
  return file;
}
function snapshot(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return { version: db.prepare("SELECT version FROM schema_version").get(), catalog: db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(),
    schemaCookie: db.prepare("PRAGMA schema_version").get(), rows: Object.fromEntries(["workspace_identity", "task", "task_scope", "approver", "credential", "action_ledger", "ledger_seal", "ledger_checkpoint"].map(t => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()])) }; }
  finally { db.close(); }
}
function staleFinding(db: DatabaseSync) {
  const sql = String(db.prepare("SELECT sql FROM sqlite_master WHERE name='finding'").get()!["sql"]);
  db.exec("PRAGMA foreign_keys=OFF; BEGIN");
  db.exec(sql.replace(FINDING_SOURCES, FINDING_SOURCES_BEFORE_LEAD).replace(/^CREATE TABLE (?:IF NOT EXISTS )?finding/, "CREATE TABLE finding_old"));
  db.exec("INSERT INTO finding_old SELECT * FROM finding; DROP TABLE finding; ALTER TABLE finding_old RENAME TO finding; CREATE INDEX finding_family ON finding(family_root,state); COMMIT");
}
test("positive177 migrates to current schema without changing identity/history or the database file, and current reopen runs no DDL", () => {
  expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(178); expect(UPDATE_SAFE_MIGRATIONS).toContain(178);
  const file = source177(), before = snapshot(file), inode = statSync(file);
  openStore(file).close(); const after = snapshot(file);
  expect(after.version?.["version"]).toBe(SCHEMA_VERSION); expect(after.catalog).toHaveLength(724); expect(after.rows).toEqual(before.rows);
  expect(statSync(file).ino).toBe(inode.ino); expect(statSync(file).dev).toBe(inode.dev);
  openStore(file).close(); expect(snapshot(file)).toEqual(after);
});
test.each(["before-index", "after-index"] as const)("interrupted -177 %s resumes idempotently without reminting identity", phase => {
  const file = source177(), before = snapshot(file);
  if (phase === "before-index") { const raw = new DatabaseSync(file); raw.exec("UPDATE schema_version SET version=-177"); raw.close(); }
  else expect(() => openStore(file, { migrationStep: step => { if (step === "action-ledger-index") throw Error("interrupted"); } })).toThrow("interrupted");
  const interrupted = snapshot(file); expect(interrupted.version?.["version"]).toBe(-177); expect(interrupted.rows).toEqual(before.rows);
  expect(interrupted.catalog.filter(r => r["name"] === V178_INDEX)).toHaveLength(phase === "after-index" ? 1 : 0);
  openStore(file).close(); expect(snapshot(file).rows).toEqual(before.rows); expect(snapshot(file).version?.["version"]).toBe(SCHEMA_VERSION);
});
test("177/-177/current reject missing, damaged or corrupt identity before epoch or compatibility DDL", () => {
  for (const version of [177, -177, SCHEMA_VERSION]) for (const damage of ["table", "row", "guard", "metadata"] as const) {
    const file = source177(); if (version === SCHEMA_VERSION) openStore(file).close();
    const db = new DatabaseSync(file); staleFinding(db);
    if (damage === "table") db.exec("DROP TABLE workspace_identity");
    if (damage === "guard") db.exec("DROP TRIGGER workspace_identity_immutable");
    if (damage === "row") {
      db.exec("DROP TRIGGER workspace_identity_not_deleted; DELETE FROM workspace_identity");
      db.exec(V177_SCHEMA.slice(V177_SCHEMA.indexOf("CREATE TRIGGER IF NOT EXISTS workspace_identity_not_deleted")));
    }
    if (damage === "metadata") db.exec("PRAGMA ignore_check_constraints=ON; UPDATE workspace_identity SET recovery_generation='damaged'");
    db.prepare("UPDATE schema_version SET version=?").run(version); db.close();
    const raw = new DatabaseSync(file, { readOnly: true });
    const catalog = raw.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all(), cookie = raw.prepare("PRAGMA schema_version").get();
    const identity = damage === "table" ? null : raw.prepare("SELECT * FROM workspace_identity").all(); raw.close();
    const steps: string[] = [];
    expect(() => openStore(file, { migrationStep: step => steps.push(step) })).toThrow(/workspace identity/); expect(steps).toEqual([]);
    const after = new DatabaseSync(file, { readOnly: true });
    expect(after.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(version);
    expect(after.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all()).toEqual(catalog);
    expect(after.prepare("PRAGMA schema_version").get()).toEqual(cookie);
    if (damage !== "table") expect(after.prepare("SELECT * FROM workspace_identity").all()).toEqual(identity); after.close();
  }
});
test("current index damage is refused before compatibility replay; poisoned177 index is never silently replaced", () => {
  for (const [version, damage] of [[177, "variant"], [-177, "variant"], [SCHEMA_VERSION, "missing"], [SCHEMA_VERSION, "variant"], [177, "ordinary"], [-177, "ordinary"], [SCHEMA_VERSION, "ordinary"]] as const) {
    const file = source177(); if (version === SCHEMA_VERSION) openStore(file).close();
    const db = new DatabaseSync(file); staleFinding(db);
    db.exec(`DROP INDEX IF EXISTS ${V178_INDEX}`);
    if (damage === "variant") db.exec(`CREATE INDEX ${V178_INDEX} ON action_ledger(actor,id)`);
    if (damage === "ordinary") db.exec(`CREATE INDEX ${V178_INDEX} ON action_ledger(action,id)`);
    db.prepare("UPDATE schema_version SET version=?").run(version);
    db.close(); const originalBytes = readFileSync(file), before = snapshot(file), steps: string[] = [];
    expect(() => openStore(file, { migrationStep: step => steps.push(step) })).toThrow(/action ledger action index/);
    expect(steps).toEqual([]); expect(snapshot(file)).toEqual(before); expect(readFileSync(file).equals(originalBytes)).toBe(true);
  }
});
test("-SCHEMA_VERSION is impossible and never changes the source", () => {
  const file = source177(), db = new DatabaseSync(file); db.prepare("UPDATE schema_version SET version=?").run(-SCHEMA_VERSION); db.close();
  const before = snapshot(file); expect(() => openStore(file)).toThrow(/mid-flight marker no build ever wrote/); expect(snapshot(file)).toEqual(before);
});
test("actual178 plans index no-event action lookup and candidate q uses primary key without dropping strict predicates", () => {
  const s = openStore(":memory:");
  try {
    const global = s.handle.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM action_ledger WHERE action=? LIMIT 1").all(CHECK_RECOVERY_HELD);
    expect(global.some(r => /SEARCH.*action_ledger_action.*action=\?/.test(String(r["detail"])))).toBe(true);
    const source = readFileSync(new URL("./check-recovery-hold.ts", import.meta.url), "utf8");
    const sql = /const events = store\.handle\.prepare\(`([\s\S]*?)`\)/.exec(source)?.[1]; if (sql === undefined) throw Error("actual reader query missing");
    const plan = s.handle.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(CHECK_RECOVERY_HELD, "[1]", '["kept"]', "[1]", '["kept"]', "[1]");
    expect(plan.some(r => /SEARCH h USING INDEX action_ledger_action/.test(String(r["detail"])))).toBe(true);
    expect(plan.some(r => /SEARCH q USING INTEGER PRIMARY KEY/.test(String(r["detail"])))).toBe(true);
    expect(sql).toContain("CAST(q.id AS TEXT) = h.outcome");
    expect(sql).toContain("json_extract(h.detail, '$.r')"); expect(sql).toContain("h.task_id IN");
  } finally { s.close(); }
});


test("current valid identity/index with stale findings refuses without creating an impossible epoch", () => {
  const file = source177(); openStore(file).close();
  const raw = new DatabaseSync(file); staleFinding(raw); raw.close(); const before = snapshot(file), steps: string[] = [];
  expect(() => openStore(file, { migrationStep: step => steps.push(step) })).toThrow(/current finding schema is stale/);
  expect(steps).toEqual([]); expect(snapshot(file)).toEqual(before); expect(snapshot(file).version?.["version"]).toBe(SCHEMA_VERSION);
});
test.each([177, -177])("valid %s source keeps legacy finding replay without changing retained identity/authority", version => {
  const file = source177(), raw = new DatabaseSync(file); staleFinding(raw); raw.prepare("UPDATE schema_version SET version=?").run(version); raw.close();
  const before = snapshot(file); openStore(file).close(); const after = snapshot(file);
  expect(after.version?.["version"]).toBe(SCHEMA_VERSION); expect(after.rows).toEqual(before.rows);
  const db = new DatabaseSync(file, { readOnly: true }); expect(String(db.prepare("SELECT sql FROM sqlite_master WHERE name='finding'").get()!["sql"])).toContain(FINDING_SOURCES); db.close();
});


test.each([177, -177])("exact partial index on %s resumes without changing identity/history", version => {
  const file = source177(), raw = new DatabaseSync(file);
  raw.exec(V178_SCHEMA); raw.prepare("UPDATE schema_version SET version=?").run(version); raw.close();
  const before = snapshot(file); openStore(file).close(); const after = snapshot(file);
  expect(after.version?.["version"]).toBe(SCHEMA_VERSION); expect(after.rows).toEqual(before.rows);
  const db = new DatabaseSync(file, { readOnly: true });
  expect(db.prepare("PRAGMA index_list('action_ledger')").all().find(row => row["name"] === V178_INDEX)).toMatchObject({ partial: 1, unique: 0, origin: "c" });
  expect(db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(V178_INDEX)?.["sql"]).toContain("WHERE action = 'checks recovery held'"); db.close();
});
