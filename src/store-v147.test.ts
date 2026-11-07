/**
 * Schema v147 and local mode's initialization (easy-start plan F, C4). Isolated fixtures only: production databases are
 * never opened here.
 *
 * - The migration adds local_mode and the password, authority and key columns; every saved row reads its declared
 *   value, and a crash after the epoch or after any step resumes on the next open to the same rows.
 * - Initialization is separate: only a database `up --laptop` made (created-by laptop, written with installed-at),
 *   with no account, never a migration or a `serve` setup database.
 * - An owner with no password set never passes a password check; enrollment and turning local mode off each end what
 *   stood on the old state, once.
 */
import { afterEach, describe, expect, test } from "vitest";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { addApprover, authenticateAccount, authenticateApprover, hashPassword, proveAccountNow, proveCredential } from "./scope.js";
import { setPasswordless, passwordlessOn } from "./passwordless.js";
import { PersistentSessions } from "./server/session.js";
import {
  enrollOwnerPassword, initLocalMode, installationCreatedBy, localModeOf, localOwnerBinding, openStore, SCHEMA_VERSION, setLocalModeOff, UPDATE_SAFE_MIGRATIONS,
  updateSafeSchema, V147_ADDED_COLUMNS, V147_STEPS, type MigrationStep, type Store,
} from "./store.js";
import { changedHistory, historySnapshot } from "./toolroll-update.js";

let dir: string | undefined;
const open: Store[] = [];
afterEach(() => { for (const one of open.splice(0)) { try { one.close(); } catch { /* closed */ } } if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });
const opened = (store: Store): Store => { open.push(store); return store; };
const NOW = new Date("2026-11-03T12:00:00.000Z");
const session = (idHash: string, account: string, generation: number) => ({ idHash, account, csrf: "c".repeat(64), role: "approver" as const, generation, createdAt: NOW.getTime(), lastSeen: NOW.getTime(),
  project: null, projectRevision: 1, ssoAt: null, agent: null, address: null, authority: "full" as const, localGeneration: null, keyEpoch: null, keyHash: null });

/** A v146 database with every kind of account: an operator, a viewer, a revoked one, an SSO-only one; Passwordless on;
 * a kept browser session and a console record. Returns its path. */
function v146Fixture(version: 146 | -146): string {
  dir ??= mkdtempSync(join(tmpdir(), "so-v147-"));
  const file = join(dir, `v146-${version < 0 ? "mid" : "at"}.db`);
  const first = openStore(file);
  const alex = addApprover(first, "alex", NOW);
  const robin = addApprover(first, "robin", NOW, alex.ok ? { name: "alex", token: alex.token } : undefined);
  const carol = addApprover(first, "carol", NOW, alex.ok ? { name: "alex", token: alex.token } : undefined);
  if (!alex.ok || !robin.ok || !carol.ok) throw new Error("fixture accounts");
  first.handle.prepare("UPDATE approver SET role = 'viewer' WHERE name = 'robin'").run();
  first.handle.prepare("UPDATE approver SET revoked_at = ?, revoked_by = 'alex' WHERE name = 'carol'").run(NOW.toISOString());
  first.handle.prepare("INSERT INTO approver (name, credential_hash, added_at, generation) VALUES ('dana', 'sso-only$x', ?, 1)").run(NOW.toISOString());
  setPasswordless(first, true, "alex", NOW);
  first.saveWebSession(session("a".repeat(64), "alex", 1));
  first.handle.prepare("INSERT INTO console_instance (id, secret, pid, port, build, socket, started_at) VALUES (1, ?, 1, 4180, 'b', 'abcdef0123456789.sock', ?)").run("f".repeat(64), NOW.toISOString());
  first.sealLedger();
  first.close();
  // The v146 shape: no local_mode table, none of the v147 columns.
  const db = new DatabaseSync(file);
  db.exec("DROP TABLE local_mode");
  for (const [table, columns] of Object.entries(V147_ADDED_COLUMNS)) for (const column of Object.keys(columns)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  db.close();
  return file;
}
const rowsOf = (store: Store) => Object.fromEntries(["approver", "web_session", "console_instance", "local_mode", "installation_fact"].map(table =>
  [table, store.handle.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }))]));

describe("the v147 migration", () => {
  test.each([146, -146] as const)("v%s: local mode and the new columns arrive; every saved row reads its declared value and nothing else changes", version => {
    const file = v146Fixture(version);
    const db = new DatabaseSync(file);
    const before = historySnapshot(db);
    db.close();
    expect(updateSafeSchema(146)).toBe(true);
    expect(UPDATE_SAFE_MIGRATIONS).toContain(147);
    expect(SCHEMA_VERSION).toBe(155);
    const store = opened(openStore(file));
    expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(155);
    // Every account has a password, whatever its role or standing (the SSO-only one's hash still never matches).
    expect(store.handle.prepare("SELECT name, password_set FROM approver ORDER BY name").all().map(row => ({ ...row }))).toEqual(
      ["alex", "carol", "dana", "robin"].map(name => ({ name, password_set: 1 })));
    expect(store.accountOf("dana")?.passwordSet).toBe(true);
    // A kept session is full, with no local binding and no key (its next mutation asks to reconnect: 1c).
    expect({ ...store.handle.prepare("SELECT authority, local_generation, key_epoch, key_hash FROM web_session").get() }).toEqual({ authority: "full", local_generation: null, key_epoch: null, key_hash: null });
    expect(store.webSession("a".repeat(64))).toMatchObject({ authority: "full", localGeneration: null, keyEpoch: null, keyHash: null });
    expect({ ...store.handle.prepare("SELECT key_epoch FROM console_instance").get() }).toEqual({ key_epoch: null });
    // No local mode, Passwordless unchanged, and a migration never initializes local mode.
    expect(localModeOf(store)).toBeNull();
    expect(installationCreatedBy(store)).toBeNull();
    expect(passwordlessOn(store)).toBe(true);
    expect(initLocalMode(store, { owner: "alex", fenceAvailable: true, now: NOW })).toEqual({ ok: false, reason: "not-laptop" });
    // The new shapes refuse what they can't name.
    expect(() => store.handle.prepare("UPDATE approver SET password_set = 2").run()).toThrow();
    expect(() => store.handle.prepare("UPDATE web_session SET authority = 'root'").run()).toThrow();
    expect(() => store.handle.prepare("UPDATE web_session SET local_generation = 0").run()).toThrow();
    expect(() => store.handle.prepare("INSERT INTO local_mode (id, owner, generation, enabled, initialized_at, changed_at) VALUES (2, 'alex', 1, 1, 't', 't')").run()).toThrow();
    expect(() => store.handle.prepare("INSERT INTO local_mode (id, owner, generation, enabled, initialized_at, changed_at) VALUES (1, 'nobody', 1, 1, 't', 't')").run()).toThrow();
    expect(store.handle.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    store.close();
    open.length = 0;
    const after = new DatabaseSync(file, { readOnly: true });
    try { expect(changedHistory(after, before)).toEqual([]); } finally { after.close(); }
  });

  test.each(V147_STEPS.map(step => [step]))("a crash after %s resumes on the next open, to exactly the rows an uninterrupted migration makes", (step: MigrationStep) => {
    const fixture = v146Fixture(146);
    const reference = join(dir!, "reference.db"), crashed = join(dir!, "crashed.db");
    copyFileSync(fixture, reference);
    copyFileSync(fixture, crashed);
    const whole = opened(openStore(reference));
    expect(() => openStore(crashed, { migrationStep: at => { if (at === step) throw new Error(`crash after ${at}`); } })).toThrow(`crash after ${step}`);
    // Mid-flight: the epoch sentinel stays, so no reader takes the half-made shape for v146 or v147.
    const peek = new DatabaseSync(crashed, { readOnly: true });
    try { expect(peek.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(-146); } finally { peek.close(); }
    const resumed = opened(openStore(crashed));
    expect(resumed.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(155);
    expect(rowsOf(resumed)).toEqual(rowsOf(whole));
  });
});

describe("local mode's initialization", () => {
  test("created-by laptop is written with installed-at, only for a new database", () => {
    dir = mkdtempSync(join(tmpdir(), "so-v147-"));
    const laptop = opened(openStore(join(dir, "laptop.db"), { createdBy: "laptop" }));
    const facts = laptop.handle.prepare("SELECT key, value, created_at FROM installation_fact WHERE key IN ('installed-at','created-by') ORDER BY key").all().map(row => ({ ...row }));
    expect(facts).toHaveLength(2);
    expect(facts[0]).toMatchObject({ key: "created-by", value: "laptop" });
    expect(facts[0]!["created_at"]).toBe(facts[1]!["created_at"]);
    // `serve` (and every older start) makes a database with no creator fact; an existing database never gains one.
    const plain = join(dir, "plain.db");
    opened(openStore(plain)).close();
    expect(installationCreatedBy(opened(openStore(plain, { createdBy: "laptop" })))).toBeNull();
  });

  test("only a laptop database with no account and a fence; one transaction; a retry adds nothing and writes no second ledger line", () => {
    dir = mkdtempSync(join(tmpdir(), "so-v147-"));
    const store = opened(openStore(join(dir, "laptop.db"), { createdBy: "laptop" }));
    expect(initLocalMode(store, { owner: "alex", fenceAvailable: false, now: NOW })).toEqual({ ok: false, reason: "no-fence" });
    expect(store.listApprovers()).toEqual([]);
    expect(initLocalMode(store, { owner: "alex", fenceAvailable: true, now: NOW })).toEqual({ ok: true, owner: "alex", generation: 1 });
    expect(localModeOf(store)).toEqual({ owner: "alex", generation: 1, enabled: true, initializedAt: NOW.toISOString(), changedAt: NOW.toISOString() });
    expect(store.accountOf("alex")).toMatchObject({ passwordSet: false, role: "approver", revokedAt: null, projects: null, generation: 1 });
    expect(store.isInstanceOperator("alex")).toBe(true);
    expect(localOwnerBinding(store)).toEqual({ account: "alex", localGeneration: 1, accountGeneration: 1 });
    const ledger = () => store.handle.prepare("SELECT count(*) AS n FROM action_ledger WHERE action = 'local mode on'").get()!["n"];
    expect(ledger()).toBe(1);
    expect(initLocalMode(store, { owner: "alex", fenceAvailable: true, now: NOW })).toEqual({ ok: false, reason: "already" });
    expect(initLocalMode(store, { owner: "robin", fenceAvailable: true, now: NOW })).toEqual({ ok: false, reason: "already" });
    expect(ledger()).toBe(1);
    expect(store.listApprovers().map(one => one.name)).toEqual(["alex"]);
  });

  test("a laptop database that already has an account (a crashed older start, or any other road) is never initialized", () => {
    dir = mkdtempSync(join(tmpdir(), "so-v147-"));
    const store = opened(openStore(join(dir, "laptop.db"), { createdBy: "laptop" }));
    expect(addApprover(store, "alex", NOW).ok).toBe(true);
    expect(initLocalMode(store, { owner: "robin", fenceAvailable: true, now: NOW })).toEqual({ ok: false, reason: "has-accounts" });
    expect(localModeOf(store)).toBeNull();
    expect(store.handle.prepare("SELECT count(*) AS n FROM action_ledger WHERE action = 'local mode on'").get()!["n"]).toBe(0);
  });

  test("a `serve` setup database with no account is never initialized (no creator fact)", () => {
    dir = mkdtempSync(join(tmpdir(), "so-v147-"));
    const store = opened(openStore(join(dir, "serve.db")));
    expect(store.listApprovers()).toEqual([]);
    expect(initLocalMode(store, { owner: "alex", fenceAvailable: true, now: NOW })).toEqual({ ok: false, reason: "not-laptop" });
    expect(localModeOf(store)).toBeNull();
  });
});

describe("an owner with no password", () => {
  const laptopOwner = (): Store => {
    dir = mkdtempSync(join(tmpdir(), "so-v147-"));
    const store = opened(openStore(join(dir, "laptop.db"), { createdBy: "laptop" }));
    if (!initLocalMode(store, { owner: "alex", fenceAvailable: true, now: NOW }).ok) throw new Error("init");
    return store;
  };

  test("no password ever passes a password check: empty, random, or the stored hash itself", () => {
    const store = laptopOwner();
    const hash = store.accountOf("alex")!.credentialHash;
    for (const typed of ["", "x", hash, "a".repeat(64)]) {
      expect(authenticateAccount(store, "alex", typed).ok, typed).toBe(false);
      expect(authenticateApprover(store, "alex", typed).ok, typed).toBe(false);
      expect(proveCredential(store, "alex", typed).ok, typed).toBe(false);
      expect(proveAccountNow(store, "alex", typed).ok, typed).toBe(false);
    }
    // Even a hash that would verify does not, while password_set is 0 (fail closed on the flag, not the hash).
    store.handle.prepare("UPDATE approver SET credential_hash = ? WHERE name = 'alex'").run(hashPassword("known"));
    expect(authenticateAccount(store, "alex", "known").ok).toBe(false);
  });

  test("enrollment: once, at the bound generation; it ends every session and keeps local mode on", () => {
    const store = laptopOwner();
    const sessions = new PersistentSessions(store);
    sessions.set("1".repeat(64), { name: "alex", csrf: "c", role: "approver", generation: 1, createdAt: NOW.getTime(), lastSeen: NOW.getTime(), project: null, projectRevision: 1, sawBoardAt: null,
      authority: "local-owner", localGeneration: 1, keyEpoch: "e1", keyHash: "h1" });
    // Saved and read back exactly: the authority and binding travel with the session.
    expect(new PersistentSessions(store).load("1".repeat(64))).toMatchObject({ authority: "local-owner", localGeneration: 1, keyEpoch: "e1", keyHash: "h1" });
    expect(enrollOwnerPassword(store, "alex", hashPassword("pw-1"), 2, NOW)).toEqual({ ok: false, reason: "local-mode-changed" });
    expect(enrollOwnerPassword(store, "robin", hashPassword("pw-1"), 1, NOW)).toEqual({ ok: false, reason: "not-owner" });
    expect(store.accountOf("alex")!.passwordSet).toBe(false);
    expect(enrollOwnerPassword(store, "alex", hashPassword("pw-1"), 1, NOW)).toEqual({ ok: true, generation: 2 });
    expect(store.accountOf("alex")).toMatchObject({ passwordSet: true, generation: 2 });
    expect(store.webSessions("alex")).toEqual([]);
    expect(authenticateAccount(store, "alex", "pw-1").ok).toBe(true);
    expect(localModeOf(store)).toMatchObject({ enabled: true, generation: 1 });
    expect(localOwnerBinding(store)).toEqual({ account: "alex", localGeneration: 1, accountGeneration: 2 });
    // The concurrent loser: a password was just set.
    expect(enrollOwnerPassword(store, "alex", hashPassword("pw-2"), 1, NOW)).toEqual({ ok: false, reason: "already-set" });
    expect(authenticateAccount(store, "alex", "pw-2").ok).toBe(false);
    expect(store.handle.prepare("SELECT count(*) AS n FROM action_ledger WHERE action = 'password set'").get()!["n"]).toBe(1);
  });

  test("turning local mode off takes full authority; it moves the generation and ends every local-owner session", () => {
    const store = laptopOwner();
    store.saveWebSession({ ...session("2".repeat(64), "alex", 1), authority: "local-owner", localGeneration: 1 });
    expect(setLocalModeOff(store, { name: "alex", authority: "local-owner" }, NOW)).toEqual({ ok: false, reason: "not-allowed" });
    expect(setLocalModeOff(store, { name: "robin", authority: "full" }, NOW)).toEqual({ ok: false, reason: "not-allowed" });
    expect(localModeOf(store)).toMatchObject({ enabled: true, generation: 1 });
    expect(setLocalModeOff(store, { name: "alex", authority: "full" }, NOW)).toEqual({ ok: true, generation: 2 });
    expect(localModeOf(store)).toMatchObject({ enabled: false, generation: 2 });
    expect(store.webSessions("alex")).toEqual([]);
    expect(localOwnerBinding(store)).toBeNull();
    expect(setLocalModeOff(store, { name: "alex", authority: "full" }, NOW)).toEqual({ ok: false, reason: "not-on" });
  });

  test("a saved session whose authority this build can't name reads as a local owner with no binding, never full", () => {
    const store = laptopOwner();
    store.saveWebSession(session("3".repeat(64), "alex", 1));
    // Written by something other than this build (the CHECK is the store's own guard; the reader fails closed too).
    store.handle.exec("PRAGMA ignore_check_constraints = ON");
    store.handle.prepare("UPDATE web_session SET authority = 'root'").run();
    store.handle.exec("PRAGMA ignore_check_constraints = OFF");
    expect(store.webSession("3".repeat(64))).toMatchObject({ authority: "local-owner", localGeneration: null });
  });
});
