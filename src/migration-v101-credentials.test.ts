/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";
import { authenticateCoordinator, mintCoordinator } from "./coordinator.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

test.each([100, -100])("v%s: a coordinator made before expiry keeps working until renewed; tokens and sessions have somewhere to live", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v101-"));
  const file = join(dir, "state.db");
  const now = new Date("2026-09-27T23:00:00.000Z");
  const first = openStore(file);
  first.handle.prepare("INSERT INTO approver (name, credential_hash, added_at, role, generation) VALUES ('alex', 'x', ?, 'approver', 1)").run(now.toISOString());
  const made = mintCoordinator(first, { name: "old-bot", repos: ["/repo/main"], by: "alex", now });
  if (!made.ok) throw new Error("mint");
  first.close();
  // The v100 shape: no tokens or sessions tables, no coordinator expiry.
  const db = new DatabaseSync(file);
  db.exec("DROP TABLE api_token; DROP TABLE web_session; ALTER TABLE coordinator_credential DROP COLUMN expires_at");
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  db.close();
  store = openStore(file);
  expect(SCHEMA_VERSION).toBe(112);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.version).toBe(112);
  expect(store.handle.prepare("SELECT expires_at FROM coordinator_credential WHERE name = 'old-bot'").get()?.["expires_at"]).toBeNull();
  expect(authenticateCoordinator(store, made.token)).toMatchObject({ ok: true });
  store.createApiToken({ id: "abcdef012345", account: "alex", name: "ci", secretHash: "0".repeat(64), access: "read", expiresAt: "2027-01-01T00:00:00.000Z", by: "alex" }, now);
  expect(store.apiTokens("alex")).toHaveLength(1);
  store.saveWebSession({ idHash: "f".repeat(64), account: "alex", csrf: "c", role: "approver", generation: 1, createdAt: now.getTime(), lastSeen: now.getTime(), project: null, projectRevision: 1, ssoAt: null, agent: null, address: null });
  expect(store.webSessions("alex")).toHaveLength(1);
});
