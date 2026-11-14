/** v157: live replies in Slack, Discord and Teams add two tables and change no saved row. docs/plans/responsive-chat.md §3.2. */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V157_STEPS } from "./store.js";
import { V157_TABLES } from "./chat-live-schema.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tables = (handle: { prepare(sql: string): { all(): unknown[] } }) =>
  (handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(one => one.name);

describe("v157", () => {
  test("a fresh database has the tables; a v156 one gains them, keeps its rows and saved chat, and may update in place", () => {
    const fresh = openStore(":memory:");
    for (const table of V157_TABLES) expect(tables(fresh.handle)).toContain(table);
    fresh.close();
    expect(SCHEMA_VERSION).toBe(161);
    expect(UPDATE_SAFE_MIGRATIONS).toContain(157);
    expect(updateSafeSchema(156)).toBe(true);
    expect(V157_STEPS).toEqual(["chat-live-tables"]);

    const dir = mkdtempSync(join(tmpdir(), "toolroll-v157-"));
    dirs.push(dir);
    const file = join(dir, "orders.db");
    const made = openStore(file);
    made.createTask({ id: "kept", title: "kept" }, new Date("2026-11-01T00:00:00.000Z"));
    made.handle.prepare(`INSERT INTO chat_event (provider, id, installation, binding, kind, channel, member, ts, thread, payload, created)
      VALUES ('slack', 'saved-event', 'inst', NULL, 'message', 'D1', 'U1', '1.000001', '1.000001', '{}', '2026-11-01T00:00:00.000Z')`).run();
    made.close();
    const raw = new DatabaseSync(file);
    for (const table of [...V157_TABLES].reverse()) raw.exec(`DROP TABLE ${table}`);
    raw.exec("UPDATE schema_version SET version = 156");
    raw.close();

    const steps: string[] = [];
    const upgraded = openStore(file, { migrationStep: one => steps.push(one) });
    expect(steps).toContain("chat-live-tables");
    for (const table of V157_TABLES) {
      expect(tables(upgraded.handle)).toContain(table);
      expect(upgraded.handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.["n"], table).toBe(0);
    }
    expect(upgraded.getTask("kept")?.title).toBe("kept");
    expect(upgraded.handle.prepare("SELECT state FROM chat_event WHERE provider = 'slack' AND id = 'saved-event'").get()?.["state"]).toBe("queued");
    // The new rows hang off a saved event, and only an app that has live replies may own one.
    upgraded.handle.prepare("INSERT INTO chat_live (provider, event, state, created, updated) VALUES ('slack', 'saved-event', 'creating', 'now', 'now')").run();
    expect(() => upgraded.handle.prepare("INSERT INTO chat_ack (provider, event, state, created, updated) VALUES ('telegram', 'saved-event', 'sent', 'now', 'now')").run()).toThrow();
    expect(upgraded.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(161);
    upgraded.close();
    const again = openStore(file);
    expect(again.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(161);
    again.close();
  });
});
