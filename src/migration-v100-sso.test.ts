/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

test.each([99, -99])("v%s: accounts carry over, and identities from the provider have somewhere to link", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v100-"));
  const file = join(dir, "state.db");
  const now = new Date("2026-09-27T22:00:00.000Z");
  const first = openStore(file);
  first.handle.prepare("INSERT INTO approver (name, credential_hash, added_at, role, generation) VALUES ('alex', 'x', ?, 'approver', 1)").run(now.toISOString());
  first.close();
  // The v99 shape: no identity table.
  const db = new DatabaseSync(file);
  db.exec("DROP TABLE sso_identity");
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  db.close();
  store = openStore(file);
  expect(SCHEMA_VERSION).toBe(110);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.version).toBe(110);
  expect(store.accountOf("alex")).toMatchObject({ role: "approver" });
  expect(store.linkSsoIdentity("alex", { issuer: "https://sso.example.com", subject: "00u1", email: "alex@acme.com", label: "Okta" }, now)).toEqual({ ok: true });
  expect(store.ssoAccount("https://sso.example.com", "00u1")).toBe("alex");
  // Another account can't claim the same identity.
  expect(store.linkSsoIdentity("sam", { issuer: "https://sso.example.com", subject: "00u1", email: null, label: "Okta" }, now)).toEqual({ ok: false, reason: "linked-elsewhere" });
  store.close();
  const shape = () => new DatabaseSync(file).prepare("SELECT sql FROM sqlite_master WHERE name = 'sso_identity'").get()?.["sql"];
  const before = shape();
  store = openStore(file);
  store.close(); store = undefined;
  expect(shape()).toBe(before);
});
