/** v188: Gate 2 passkey approval tables (`account_passkeys`, `passkey_challenges`, `device_idempotency`) and ADR 0001 backup-restore wipe. */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V188_STEPS } from "./store.js";
import { V187_TABLES, V188_TABLES } from "./companion/schema.js";
import {
  activatePendingDevice,
  claimDeviceIdempotency,
  insertAccountPasskey,
  loadOrCreateCompanionHostKeys,
  retireCompanionOnRestore,
  savePasskeyChallenge,
  savePendingDevice,
} from "./companion/store.js";
import { changedHistory, historySnapshot } from "./toolroll-update.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const T0 = new Date("2026-11-28T00:00:00.000Z");

function tableNamesMatching(file: string, tables: readonly string[]): string[] {
  const raw = new DatabaseSync(file, { readOnly: true });
  try {
    return raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map(row => String(row["name"]))
      .filter(name => tables.includes(name));
  } finally {
    raw.close();
  }
}

describe("v188: passkey phone approval tables", () => {
  test("fresh database creates v188 tables, preserves v187 companion_% set, and is classed update-safe", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(188);
    expect(UPDATE_SAFE_MIGRATIONS).toContain(188);
    expect(updateSafeSchema(187)).toBe(true);
    expect(V188_STEPS).toEqual(["companion-passkey"]);

    const dir = mkdtempSync(join(tmpdir(), "toolroll-v188-"));
    dirs.push(dir);
    const file = join(dir, "fresh.db");
    const store = openStore(file);
    try {
      expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(SCHEMA_VERSION);
    } finally {
      store.close();
    }
    expect(tableNamesMatching(file, V188_TABLES)).toEqual([...V188_TABLES].sort());

    // v187 companion_% invariant stays intact.
    const raw = new DatabaseSync(file, { readOnly: true });
    try {
      const companionTables = raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'companion_%' ORDER BY name")
        .all()
        .map(row => String(row["name"]));
      expect(companionTables).toEqual([...V187_TABLES].sort());
    } finally {
      raw.close();
    }
  });

  test("upgrades cleanly from v187 without altering history, and rolls back cleanly on interruption", () => {
    const dir = mkdtempSync(join(tmpdir(), "toolroll-v188-up-"));
    dirs.push(dir);
    const file = join(dir, "v187.db");
    const made = openStore(file);
    made.saveApprover("alex", "hash-a", T0);
    made.createTask({ id: "t1", title: "kept" }, T0);
    made.close();

    // Simulate a v187 database before v188 ran.
    const raw = new DatabaseSync(file);
    for (const table of V188_TABLES) raw.exec(`DROP TABLE IF EXISTS ${table}`);
    raw.exec("UPDATE schema_version SET version = 187");
    const before = historySnapshot(raw);
    raw.close();

    // Interrupted migration rolls back cleanly.
    expect(() =>
      openStore(file, {
        migrationStep: step => {
          if (step === "companion-passkey") throw new Error("crash-v188");
        },
      }),
    ).toThrow(/crash-v188/);
    expect(tableNamesMatching(file, V188_TABLES)).toEqual([]);

    // Next open completes v188 and leaves history intact.
    const upgraded = openStore(file);
    try {
      expect(upgraded.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(SCHEMA_VERSION);
      expect(upgraded.lookupRef("t1")).not.toBeNull();
    } finally {
      upgraded.close();
    }
    expect(tableNamesMatching(file, V188_TABLES)).toEqual([...V188_TABLES].sort());

    const after = new DatabaseSync(file, { readOnly: true });
    try {
      expect(changedHistory(after, before)).toEqual([]);
    } finally {
      after.close();
    }
  });

  test("damaged v188 table shape refuses to open", () => {
    const dir = mkdtempSync(join(tmpdir(), "toolroll-v188-dmg-"));
    dirs.push(dir);
    const file = join(dir, "damaged.db");
    openStore(file).close();
    const raw = new DatabaseSync(file);
    raw.exec("ALTER TABLE account_passkeys ADD COLUMN surprise TEXT");
    raw.close();
    expect(() => openStore(file)).toThrow(/refusing to open — the passkey approval table account_passkeys has an unknown shape/);
  });

  test("ADR 0001 backup restore wipes account_passkeys, passkey_challenges, and device_idempotency alongside host keys and devices", () => {
    const dir = mkdtempSync(join(tmpdir(), "toolroll-v188-restore-"));
    dirs.push(dir);
    const file = join(dir, "restore.db");
    const store = openStore(file);
    try {
      const id = store.workspaceIdentity();
      store.saveApprover("alex", "hash-a", T0);
      loadOrCreateCompanionHostKeys(store.handle, T0);
      savePendingDevice(store.handle, {
        deviceId: "dev_1",
        accountName: "alex",
        deviceName: "Alex iPhone",
        phoneStaticPub: Buffer.alloc(32, 1),
        deviceRelayPub: Buffer.alloc(32, 2),
        devicePsk: Buffer.alloc(32, 3),
        recoveryGeneration: id.recoveryGeneration,
        accountGeneration: store.accountOf("alex")!.generation,
        createdAt: T0.toISOString(),
      });
      expect(activatePendingDevice(store, "dev_1", T0)).toBe("activated");
      insertAccountPasskey(store.handle, {
        credentialId: "cred_1",
        workspaceId: id.id,
        accountName: "alex",
        userHandle: "uh_1",
        publicKeySpki: "spki_1",
        signCount: 0,
        label: "Alex iPhone",
        createdAt: T0.toISOString(),
        recoveryGeneration: id.recoveryGeneration,
      });
      savePasskeyChallenge(store.handle, {
        challenge: "chal_1",
        kind: "approve",
        workspaceId: id.id,
        accountName: "alex",
        deviceId: "dev_1",
        recoveryGeneration: id.recoveryGeneration,
        bindingJson: "{}",
        expiresAt: new Date(T0.getTime() + 60_000).toISOString(),
      });
      claimDeviceIdempotency(store.handle, {
        deviceId: "dev_1",
        idempotencyKey: "11111111-1111-4111-8111-111111111111",
        method: "task.approve",
        requestHash: "abc",
        now: T0,
      });

      retireCompanionOnRestore(store.handle);

      for (const table of ["companion_host_keys", "companion_paired_device", "account_passkeys", "passkey_challenges", "device_idempotency"]) {
        expect(store.handle.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"], table).toBe(0);
      }
    } finally {
      store.close();
    }
  });
});
