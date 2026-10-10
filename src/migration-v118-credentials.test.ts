/**
 * v118 (D7): one credential table. A v117 file with every kind of machine credential (a person's live, expired,
 * revoked, rotated, project-limited and MCP sign-in tokens; live and revoked coordinators with their filings, events
 * and idempotency keys; a person's lead tokens) upgrades whole: every row arrives under its kind with its id, hash,
 * dates and terms, every presented secret still signs in exactly as before, ids two kinds shared stay apart, the
 * references point at the one table, the update rehearsal is satisfied, and a second open changes nothing.
 * Isolated fixtures only: production databases are never opened here.
 */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, V118_MERGED_TABLES, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { mintApiToken, parseLeadToken, tokenLive } from "./api-tokens.js";
import { authenticateCoordinator, listCoordinators, mintCoordinator, revokeCoordinator } from "./coordinator.js";
import { changedHistory, historySnapshot } from "./toolroll-update.js";
import { toV117 } from "../test/pre-v118.js";

const NOW = new Date("2026-10-09T10:00:00.000Z");
const LATER = "2027-10-01T00:00:00.000Z";
let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

type Seeded = { tokens: Record<string, string>; ids: Record<string, string>; coordinators: { live: string; revoked: string; collided: string }; leads: { old: string; live: string; collided: string }; collidedCid: string };

/** Every kind of credential this build makes, then the same file as v117 wrote it, with two ids two kinds share. */
function seed(file: string): Seeded {
  const s = openStore(file);
  const tokens: Record<string, string> = {}, ids: Record<string, string> = {};
  try {
    const alex = addApprover(s, "alex", NOW);
    if (!alex.ok) throw new Error("alex");
    if (!addApprover(s, "sam", NOW, { name: "alex", token: alex.token }).ok) throw new Error("sam");
    const person = (name: string, terms: { access?: "read" | "act"; expiresAt?: string; projects?: string[] | null; purpose?: "api" | "mcp" } = {}) => {
      const minted = mintApiToken();
      s.createApiToken({ id: minted.id, account: "alex", name, secretHash: minted.hash, access: terms.access ?? "act", expiresAt: terms.expiresAt ?? LATER, by: "alex",
        projects: terms.projects ?? null, ...(terms.purpose === undefined ? {} : { purpose: terms.purpose }) }, NOW);
      tokens[name] = minted.token; ids[name] = minted.id;
      return minted;
    };
    person("live"); person("reader", { access: "read" });
    person("expired", { expiresAt: "2026-10-01T00:00:00.000Z" });
    s.revokeApiToken(person("revoked").id, "alex", NOW);
    person("limited", { projects: ["/srv/shop"] });
    const rotated = person("rotated"), replacement = mintApiToken();
    expect(s.rotateApiToken(rotated.id, { id: replacement.id, secretHash: replacement.hash }, "alex", NOW, 3_600_000)).toMatchObject({ ok: true });
    tokens["replacement"] = replacement.token; ids["replacement"] = replacement.id;
    // An MCP sign-in's token, its grant and its refresh family.
    s.handle.prepare("INSERT INTO oauth_client (id, name, redirect_json, created_at, source_hash) VALUES ('client-1', 'Claude', '[\"http://127.0.0.1/cb\"]', ?, 'src')").run(NOW.toISOString());
    const mcp = mintApiToken();
    s.createOAuthGrant("code-hash", { id: mcp.id, account: "alex", name: "Claude (MCP)", secretHash: mcp.hash, access: "read", expiresAt: LATER },
      { client: "client-1", account: "alex", generation: 1, projects: ["/srv/shop"], resource: "http://127.0.0.1/mcp", accessExpiresAt: LATER, refreshHash: "f".repeat(64) }, NOW);
    tokens["mcp"] = mcp.token; ids["mcp"] = mcp.id;
    // A colliding person id: the coordinator and lead token below are given it in the v117 file.
    const shared = person("shared");

    const live = mintCoordinator(s, { name: "planner-bot", repos: ["/srv/shop"], by: "alex", now: NOW });
    const old = mintCoordinator(s, { name: "retired-bot", repos: ["/srv/shop"], by: "alex", now: NOW });
    const collided = mintCoordinator(s, { name: "shared-bot", repos: ["/srv/bank"], by: "sam", now: NOW, newCid: () => "zzzzzzzzzzzz" });
    if (!live.ok || !old.ok || !collided.ok) throw new Error("coordinators");
    expect(revokeCoordinator(s, old.cid, "alex", NOW)).toEqual({ ok: true });
    const task = s.createTask({ id: "t-coord", title: "Filed by a coordinator" }, NOW);
    expect(task.id).toBe("t-coord");
    s.handle.prepare("UPDATE task_ref SET coordinator_cid = ? WHERE external_id = 't-coord'").run(collided.cid);
    s.handle.prepare("INSERT INTO coordinator_event (cid, kind, task_id, detail, created_at) VALUES (?, 'filed', 't-coord', NULL, ?)").run(collided.cid, NOW.toISOString());
    s.handle.prepare("INSERT INTO mcp_idempotency (cid, key, request_digest, task_id, created_at) VALUES (?, 'key-00001', 'd', 't-coord', ?)").run(collided.cid, NOW.toISOString());

    const firstLead = s.mintLeadCredential("alex", "alex", NOW).token;
    const liveLead = s.mintLeadCredential("alex", "alex", NOW).token;
    const collidedLead = s.mintLeadCredential("sam", "sam", NOW).token;
    s.close();

    const db = new DatabaseSync(file);
    toV117(db);
    // Two kinds sharing one id, as separate tables allowed: the coordinator (with its references) and the lead token.
    db.exec("PRAGMA foreign_keys = OFF");
    for (const [table, column] of [["coordinator_credential", "cid"], ["task_ref", "coordinator_cid"], ["coordinator_event", "cid"], ["mcp_idempotency", "cid"]] as const) {
      db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(shared.id, collided.cid);
    }
    const leadId = parseLeadToken(collidedLead)!.id;
    db.prepare("UPDATE lead_credential SET id = ? WHERE id = ?").run(shared.id, leadId);
    db.close();
    return { tokens, ids, coordinators: { live: live.token, revoked: old.token, collided: collided.token },
      leads: { old: firstLead, live: liveLead, collided: collidedLead.replace(`lt_${leadId}_`, `lt_${shared.id}_`) }, collidedCid: shared.id };
  } catch (error) { s.close(); throw error; }
}

test("a v117 file with every kind of credential upgrades whole into the one credential table", () => {
  dir = mkdtempSync(join(tmpdir(), "so-v118-"));
  const file = join(dir, "state.db");
  const seeded = seed(file);
  const old = new DatabaseSync(file);
  const history = historySnapshot(old);
  const tokensBefore = old.prepare("SELECT * FROM api_token ORDER BY rowid").all().map(row => ({ ...row }));
  const counts = Object.fromEntries(Object.keys(V118_MERGED_TABLES).map(table => [table, Number(old.prepare(`SELECT count(*) AS n FROM ${table}`).get()!["n"])]));
  const ledgerBefore = Number(old.prepare("SELECT count(*) AS n FROM action_ledger").get()!["n"]);
  old.close();

  expect(UPDATE_SAFE_MIGRATIONS).toContain(118);
  store = openStore(file);
  expect(SCHEMA_VERSION).toBe(118);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(118);
  for (const table of Object.keys(V118_MERGED_TABLES)) expect(store.handle.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(table), table).toBeUndefined();
  // Every row arrived under its kind; nothing was minted and the ledger gained nothing.
  expect(Object.fromEntries(Object.entries(V118_MERGED_TABLES).map(([table, kind]) => [table, Number(store!.handle.prepare("SELECT count(*) AS n FROM credential WHERE kind = ?").get(kind)!["n"])]))).toEqual(counts);
  expect(Number(store.handle.prepare("SELECT count(*) AS n FROM action_ledger").get()!["n"])).toBe(ledgerBefore);

  // A person's tokens: same ids, hashes, dates and terms, and each presented secret signs in exactly as before.
  const tokensAfter = store.handle.prepare(`SELECT id, account, name, secret_hash, access, created_at, created_by, expires_at, last_used_at, revoked_at, revoked_by,
    projects_json, replaces, replaced_by, overlap_until, purpose FROM credential WHERE kind = 'person' ORDER BY rowid`).all().map(row => ({ ...row }));
  expect(tokensAfter).toEqual(tokensBefore);
  const live = (name: string) => {
    const found = store!.presentedCredential(seeded.tokens[name]!);
    expect(found, name).toEqual({ kind: "person", id: seeded.ids[name] });
    return tokenLive(store!.apiTokenSecret(found!.id)!.row, NOW.getTime());
  };
  expect(Object.fromEntries(["live", "reader", "expired", "revoked", "limited", "rotated", "replacement", "mcp", "shared"].map(name => [name, live(name)]))).toEqual({
    live: true, reader: true, expired: false, revoked: false, limited: true, rotated: true, replacement: true, mcp: true, shared: true });
  expect(store.apiTokenSecret(seeded.ids["limited"]!)!.row.projects).toEqual(["/srv/shop"]);
  expect(store.apiTokenSecret(seeded.ids["reader"]!)!.row.access).toBe("read");
  expect(store.oauthGrant(seeded.ids["mcp"]!)).toMatchObject({ client: "client-1", projects: ["/srv/shop"] });
  // A rotation's replacement is the next generation.
  expect(store.handle.prepare("SELECT generation FROM credential WHERE id = ?").get(seeded.ids["replacement"])?.["generation"]).toBe(2);
  expect(store.handle.prepare("SELECT generation FROM credential WHERE id = ?").get(seeded.ids["rotated"])?.["generation"]).toBe(1);

  // Coordinators: the live one signs in, the revoked one stays revoked, and the one whose id a token held is kept apart.
  const coordinator = authenticateCoordinator(store, seeded.coordinators.live);
  expect(coordinator).toMatchObject({ ok: true, who: { name: "planner-bot", repos: ["/srv/shop"], perHour: 6 } });
  expect(authenticateCoordinator(store, seeded.coordinators.revoked)).toEqual({ ok: false, reason: "revoked" });
  const collided = authenticateCoordinator(store, seeded.coordinators.collided);
  expect(collided).toMatchObject({ ok: true, who: { cid: `coordinator:${seeded.collidedCid}`, name: "shared-bot", repos: ["/srv/bank"] } });
  expect(store.handle.prepare("SELECT coordinator_cid FROM task_ref WHERE external_id = 't-coord'").get()?.["coordinator_cid"]).toBe(`coordinator:${seeded.collidedCid}`);
  expect(store.handle.prepare("SELECT cid FROM coordinator_event WHERE task_id = 't-coord'").all().map(row => row["cid"])).toEqual([`coordinator:${seeded.collidedCid}`]);
  expect(store.handle.prepare("SELECT cid FROM mcp_idempotency").all().map(row => row["cid"])).toEqual([`coordinator:${seeded.collidedCid}`]);
  // Its label still names the id it was made with.
  expect(store.coordinatorProvenanceOf("t-coord")?.label).toBe(`mcp:shared-bot#${seeded.collidedCid.slice(0, 4)}`);
  expect(listCoordinators(store).map(one => [one.name, one.revokedAt === null]).sort()).toEqual([["planner-bot", true], ["retired-bot", false], ["shared-bot", true]]);

  // Lead tokens: the newest is live, the one it replaced is not, and the one whose id a token held still signs in.
  expect(store.leadFor(seeded.leads.live)?.owner).toBe("alex");
  expect(store.leadFor(seeded.leads.old)).toBeNull();
  expect(store.leadFor(seeded.leads.collided)).toEqual({ owner: "sam", id: seeded.collidedCid });
  expect(store.handle.prepare("SELECT id FROM credential WHERE kind = 'lead' AND account = 'sam'").get()?.["id"]).toBe(`lead:${seeded.collidedCid}`);
  expect(store.handle.prepare("SELECT generation FROM credential WHERE kind = 'lead' AND account = 'alex' AND revoked_at IS NULL").get()?.["generation"]).toBe(2);
  // A credential is only ever its own kind: a lead token is no API token, a coordinator's secret no lead's.
  expect(store.presentedCredential(seeded.leads.live)?.kind).toBe("lead");
  expect(store.apiTokenSecret(`lead:${seeded.collidedCid}`)).toBeNull();

  // The references name the one table, nothing points nowhere, and the rehearsal is satisfied.
  const ddl = store.handle.prepare("SELECT group_concat(sql, ';') AS ddl FROM sqlite_master WHERE type = 'table'").get()!["ddl"] as string;
  expect(ddl).not.toMatch(/REFERENCES (api_token|coordinator_credential|lead_credential)\b/);
  expect(ddl).toContain("token              TEXT PRIMARY KEY REFERENCES credential(id)");
  expect(store.handle.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  const after = new DatabaseSync(file, { readOnly: true });
  try { expect(changedHistory(after, history)).toEqual([]); } finally { after.close(); }
  // A coordinator minted now is in the ledger, as before.
  expect(mintCoordinator(store, { name: "release-bot", repos: ["/srv/shop"], by: "alex", now: NOW }).ok).toBe(true);
  expect(store.actionLedger({ repos: null, limit: 5 }).find(one => one.action === "coordinator minted: release-bot")).toMatchObject({ actor: "alex", outcome: "minted", source: "access", detail: 'projects: ["/srv/shop"]' });
  store.close(); store = undefined;

  // A second open changes nothing.
  const shape = () => { const db = new DatabaseSync(file, { readOnly: true }); try { return db.prepare("SELECT group_concat(type || name || coalesce(sql, ''), ';') AS s FROM sqlite_master").get()!["s"]; } finally { db.close(); } };
  const before = shape();
  store = openStore(file);
  store.close(); store = undefined;
  expect(shape()).toBe(before);
});

test("a fresh file and an upgraded one end in the same credential shape", () => {
  dir = mkdtempSync(join(tmpdir(), "so-v118-shape-"));
  const ddl = (file: string) => { const db = new DatabaseSync(file, { readOnly: true }); try { return db.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'credential' OR sql LIKE '%credential(id)%' ORDER BY type, name").all().map(row => ({ ...row })); } finally { db.close(); } };
  openStore(join(dir, "fresh.db")).close();
  const upgraded = join(dir, "upgraded.db");
  openStore(upgraded).close();
  const db = new DatabaseSync(upgraded);
  toV117(db);
  db.close();
  openStore(upgraded).close();
  expect(ddl(upgraded)).toEqual(ddl(join(dir, "fresh.db")));
});
