/** Phone records (§1.3, §2.5, §7): activation is atomic and bounded, tombstones keep why for 30 days, Settings' list and
 * rename answer per account, and reads create nothing. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { openStore, type Store } from "../store.js";
import { addApprover } from "../scope.js";
import { activatePendingDevice, listPhones, livePairedDevices, PENDING_ACTIVATION_MS, renamePhone, revokePairedDeviceRecord, sanitizeDeviceName, savePendingDevice, sweepCompanionRecords, TOMBSTONE_MS } from "./store.js";

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  while (stores.length > 0) stores.pop()!.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const T0 = new Date("2026-11-27T10:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

function fixture(): Store {
  const dir = mkdtempSync(join(tmpdir(), "toolroll-companion-store-"));
  dirs.push(dir);
  const store = openStore(join(dir, "toolroll.db"));
  stores.push(store);
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("alex");
  if (!addApprover(store, "bea", T0, { name: "alex", token: alex.token }).ok) throw new Error("bea");
  return store;
}

function phone(store: Store, deviceId: string, account: string, createdAt = T0): void {
  savePendingDevice(store.handle, { deviceId, accountName: account, deviceName: `${deviceId} phone`, phoneStaticPub: Buffer.alloc(32, 1), deviceRelayPub: Buffer.alloc(32, 2),
    devicePsk: Buffer.alloc(32, 3), recoveryGeneration: store.workspaceIdentity().recoveryGeneration, accountGeneration: store.accountOf(account)!.generation, createdAt: createdAt.toISOString() });
}

test("activation: once, within 10 minutes, only while the account stands at its generation", () => {
  const store = fixture();
  phone(store, "dev_a", "alex");
  phone(store, "dev_late", "alex");
  phone(store, "dev_moved", "bea");
  expect(activatePendingDevice(store, "dev_a", at(1_000))).toBe("activated");
  expect(activatePendingDevice(store, "dev_a", at(2_000))).toBe("already_active");
  expect(activatePendingDevice(store, "dev_late", at(PENDING_ACTIVATION_MS + 1))).toBe("refused");
  store.handle.prepare("UPDATE approver SET generation = generation + 1 WHERE name = 'bea'").run();
  expect(activatePendingDevice(store, "dev_moved", at(1_000))).toBe("refused");
  expect(activatePendingDevice(store, "dev_unknown", at(1_000))).toBe("refused");
});

test("Settings' list: active, finishing and retired-with-why per account; expired pending rows and old tombstones are gone", () => {
  const store = fixture();
  phone(store, "dev_active", "alex");
  phone(store, "dev_finishing", "alex", at(PENDING_ACTIVATION_MS));
  phone(store, "dev_stale_pending", "alex");
  phone(store, "dev_removed", "alex");
  phone(store, "dev_bea", "bea");
  for (const id of ["dev_active", "dev_removed", "dev_bea"]) expect(activatePendingDevice(store, id, at(1_000))).toBe("activated");
  revokePairedDeviceRecord(store.handle, "dev_removed", at(2_000), "removed");
  store.revokeDerivedAuthority("bea", "credential-rotation", at(3_000));
  const now = at(PENDING_ACTIVATION_MS + 60_000);
  expect(listPhones(store, { accountName: "alex", now }).map(p => [p.deviceId, p.state, p.retiredReason])).toEqual(expect.arrayContaining([
    ["dev_active", "active", null], ["dev_finishing", "finishing", null], ["dev_removed", "retired", "removed"],
  ]));
  expect(listPhones(store, { accountName: "alex", now }).map(p => p.deviceId)).not.toContain("dev_stale_pending");
  expect(listPhones(store, { accountName: "bea", now })).toEqual([expect.objectContaining({ deviceId: "dev_bea", state: "retired", retiredReason: "password_changed", name: "dev_bea phone" })]);
  // Relay admission counts pending phones too; Settings' "live" list doesn't.
  expect(livePairedDevices(store, { now }).map(d => d.deviceId)).toEqual(["dev_active"]);
  expect(livePairedDevices(store, { includePending: true, now }).map(d => d.deviceId).sort()).toEqual(["dev_active", "dev_finishing"]);
  // The sweep: the stale pending row now; the tombstones after 30 days.
  expect(sweepCompanionRecords(store.handle, now)).toEqual({ tombstones: 0, pending: ["dev_stale_pending"] });
  expect(sweepCompanionRecords(store.handle, at(TOMBSTONE_MS + 10_000))).toMatchObject({ tombstones: 2 });
  expect(listPhones(store, { accountName: "alex", now: at(TOMBSTONE_MS + 10_000) }).map(p => p.deviceId)).not.toContain("dev_removed");
});

test("rename: only the account's own live phone, sanitized like a phone-sent name", () => {
  const store = fixture();
  phone(store, "dev_a", "alex");
  expect(renamePhone(store, "dev_a", "  Work\u202e\u0007 iPhone  ", "alex")).toBe(true);
  expect(listPhones(store, { accountName: "alex", now: at(1_000) })[0]?.name).toBe("Work iPhone");
  expect(renamePhone(store, "dev_a", "Mine now", "bea")).toBe(false);
  revokePairedDeviceRecord(store.handle, "dev_a", at(1), "removed");
  expect(renamePhone(store, "dev_a", "Again", "alex")).toBe(false);
  expect(sanitizeDeviceName("x".repeat(80))).toHaveLength(48);
  expect(sanitizeDeviceName("\u200b")).toBe("iPhone");
});
