/**
 * Schema v150: the idle limit beside the cleanup setting. A saved setting reads the default and changes no other way; a
 * fresh database, an upgrade from v149 (and one stopped mid-way), and a crash after the step all end the same.
 */
import { afterEach, describe, expect, test } from "vitest";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_IDLE, V150_ADDED_COLUMNS } from "./storage.js";
import { checkoutIdle, openStore, SCHEMA_VERSION, setCheckoutIdle, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V150_STEPS, type MigrationStep, type Store } from "./store.js";

const NOW = new Date("2026-11-06T12:00:00.000Z");
let dir: string | undefined;
const open: Store[] = [];
afterEach(() => { for (const one of open.splice(0)) { try { one.close(); } catch { /* closed */ } } if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });
const opened = (store: Store): Store => { open.push(store); return store; };

/** A v149 database with a saved cleanup choice. */
function v149Fixture(version: 149 | -149): string {
  dir ??= mkdtempSync(join(tmpdir(), "so-v150-"));
  const file = join(dir, `v149-${version < 0 ? "mid" : "at"}.db`);
  const first = openStore(file);
  first.setCheckoutCleanup("7d", "alex", NOW);
  first.close();
  const db = new DatabaseSync(file);
  db.exec("ALTER TABLE checkout_cleanup_setting DROP COLUMN idle");
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  db.close();
  return file;
}
const settingOf = (store: Store) => store.handle.prepare("SELECT * FROM checkout_cleanup_setting").all().map(row => ({ ...row }));

describe("v150: the idle limit", () => {
  test("a fresh database reads the default, and only a choice writes a row", () => {
    dir = mkdtempSync(join(tmpdir(), "so-v150-"));
    const store = opened(openStore(join(dir, "fresh.db")));
    expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(SCHEMA_VERSION);
    expect(settingOf(store)).toEqual([]);
    expect(checkoutIdle(store)).toBe(DEFAULT_IDLE);
    expect(setCheckoutIdle(store, "30d", "alex", NOW)).toBe("30d");
    expect(store.checkoutCleanup()).toBe("finished");
    expect(() => store.handle.prepare("UPDATE checkout_cleanup_setting SET idle = '1d'").run()).toThrow();
  });

  test("a saved setting keeps its choice and reads the default limit, and the update may run it in place", () => {
    const store = opened(openStore(v149Fixture(149)));
    expect(store.checkoutCleanup()).toBe("7d");
    expect(checkoutIdle(store)).toBe(DEFAULT_IDLE);
    expect(settingOf(store)[0]).toMatchObject({ cleanup: "7d", idle: null });
    expect(Object.keys(V150_ADDED_COLUMNS)).toEqual(["checkout_cleanup_setting"]);
    expect(UPDATE_SAFE_MIGRATIONS).toContain(150);
    expect(updateSafeSchema(149)).toBe(true);
    setCheckoutIdle(store, "never", "alex", NOW);
    expect(settingOf(store)[0]).toMatchObject({ cleanup: "7d", idle: "never" });
  });

  test("an upgrade stopped mid-way resumes", () => {
    const store = opened(openStore(v149Fixture(-149)));
    expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(SCHEMA_VERSION);
    expect(checkoutIdle(store)).toBe(DEFAULT_IDLE);
  });

  test.each(V150_STEPS.map(step => [step]))("a crash after %s resumes on the next open, to the rows an uninterrupted migration makes", (step: MigrationStep) => {
    const file = v149Fixture(149);
    const crashed = `${file}.crashed`;
    copyFileSync(file, crashed);
    const clean = opened(openStore(file));
    expect(() => openStore(crashed, { migrationStep: finished => { if (finished === step) throw new Error("stop"); } })).toThrow("stop");
    const resumed = opened(openStore(crashed));
    expect(settingOf(resumed)).toEqual(settingOf(clean));
    expect(resumed.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(SCHEMA_VERSION);
  });
});
