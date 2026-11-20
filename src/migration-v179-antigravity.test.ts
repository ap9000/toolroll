/** v179: Antigravity ACP (`agy acp`) joins the provider CHECK constraints. Every saved row carries over untouched,
 * indexes are restored in place, and a crash after the step resumes cleanly to the same shape. */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V179_STEPS } from "./store.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const T0 = new Date("2026-11-20T00:00:00.000Z");

const OLD_ALL = "CHECK (provider IN ('claude','codex','openrouter','gemini','opencode','cursor','cline','qwen','goose'))";
const NEW_ALL = "CHECK (provider IN ('claude','codex','openrouter','gemini','opencode','cursor','cline','qwen','goose','antigravity'))";
const OLD_ACP = "CHECK (provider IN ('opencode','cursor','cline','qwen','goose'))";
const NEW_ACP = "CHECK (provider IN ('opencode','cursor','cline','qwen','goose','antigravity'))";

/** A v178 database file with the pre-Antigravity provider CHECKs and a saved row to verify preservation. */
function v178File(): string {
  const dir = mkdtempSync(join(tmpdir(), "toolroll-v179-"));
  dirs.push(dir);
  const file = join(dir, "orders.db");
  const made = openStore(file);
  made.saveApprover("alex", "hash-a", T0);
  made.createTask({ id: "kept", title: "kept" }, T0);
  made.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", T0);
  made.close();
  const raw = new DatabaseSync(file);
  const narrow = (table: string, from: string, to: string) => {
    const sql = String(raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.["sql"] ?? "");
    const cols = raw.prepare(`PRAGMA table_info(${table})`).all().map(one => String(one["name"])).join(", ");
    raw.exec("PRAGMA foreign_keys = OFF");
    raw.exec("BEGIN IMMEDIATE");
    raw.exec(sql.replace(new RegExp(`^CREATE TABLE (?:IF NOT EXISTS )?"?${table}"?`), `CREATE TABLE ${table}_old`).replace(from, to));
    raw.exec(`INSERT INTO ${table}_old (${cols}) SELECT ${cols} FROM ${table}`);
    raw.exec(`DROP TABLE ${table}`);
    raw.exec(`ALTER TABLE ${table}_old RENAME TO ${table}`);
    raw.exec("COMMIT");
    raw.exec("PRAGMA foreign_keys = ON");
  };
  for (const t of ["phase_config", "phase_tier_config", "phase_tier_alternate", "provider_readiness"]) narrow(t, NEW_ALL, OLD_ALL);
  for (const t of ["acp_attestation", "acp_check_request", "acp_billing"]) narrow(t, NEW_ACP, OLD_ACP);
  raw.exec("UPDATE schema_version SET version = 178");
  raw.close();
  return file;
}

const version = (store: ReturnType<typeof openStore>) => store.handle.prepare("SELECT version FROM schema_version").get()?.["version"];

describe("v179", () => {
  test("fresh: update-safe and accepts antigravity across routing and ACP tables", () => {
    expect(UPDATE_SAFE_MIGRATIONS).toContain(179);
    expect(updateSafeSchema(178)).toBe(true);
    expect(V179_STEPS).toEqual(["antigravity-provider"]);
    expect(SCHEMA_VERSION).toBe(179);
    const fresh = openStore(":memory:");
    try {
      fresh.setPhaseConfig("installation", "build", "antigravity", "gemini-4-neon", "alex", T0);
      expect(fresh.phaseConfig("installation", "build")).toMatchObject({ provider: "antigravity", model: "gemini-4-neon" });
      fresh.declareAcpBilling({ provider: "antigravity", runner: "mac", model: "gemini-4-neon", kind: "plan", by: "alex" }, T0);
      expect(fresh.acpBillingFor("antigravity", "mac", "gemini-4-neon")).toMatchObject({ kind: "plan" });
    } finally { fresh.close(); }
  });

  test("an upgrade from v178 widens all provider CHECKs, keeps saved rows, and resumes cleanly after a crash", () => {
    const file = v178File();
    expect(() => openStore(file, { migrationStep: one => { if (one === "antigravity-provider") throw new Error("crash"); } })).toThrow(/crash/);
    const upgraded = openStore(file);
    try {
      expect(version(upgraded)).toBe(SCHEMA_VERSION);
      expect(upgraded.lookupRef("kept")).not.toBeNull();
      expect(upgraded.phaseConfig("installation", "build")).toMatchObject({ provider: "claude", model: "sonnet" });
      upgraded.setPhaseConfig("installation", "build", "antigravity", "gemini-3.8-flash", "alex", T0);
      expect(upgraded.phaseConfig("installation", "build")).toMatchObject({ provider: "antigravity", model: "gemini-3.8-flash" });
      upgraded.declareAcpBilling({ provider: "antigravity", runner: "mac", model: "gemini-3.8-flash", kind: "plan", by: "alex" }, T0);
      expect(upgraded.acpBillingFor("antigravity", "mac", "gemini-3.8-flash")).toMatchObject({ kind: "plan" });
    } finally { upgraded.close(); }
  });
});
