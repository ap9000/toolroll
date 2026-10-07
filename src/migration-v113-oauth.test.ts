/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { mintApiToken } from "./api-tokens.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

test.each([110, -110])("v%s: MCP sign-in's tables are added and every API token stays as it was", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v113-"));
  const file = join(dir, "state.db");
  const now = new Date("2026-10-07T09:00:00.000Z");
  const first = openStore(file);
  expect(addApprover(first, "alex", now).ok).toBe(true);
  const minted = mintApiToken();
  first.createApiToken({ id: minted.id, account: "alex", name: "laptop", secretHash: minted.hash, access: "act", expiresAt: "2027-01-01T00:00:00.000Z", by: "alex" }, now);
  const tokens = first.apiTokens(null);
  first.close();
  // The v110 shape: none of the oauth_ tables.
  const db = new DatabaseSync(file);
  db.exec("DROP TABLE oauth_grant; DROP TABLE oauth_code; DROP TABLE oauth_client");
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  db.close();

  store = openStore(file);
  expect(SCHEMA_VERSION).toBe(113);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.version).toBe(113);
  expect(store.handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'oauth_%' ORDER BY name").all().map(row => row["name"]))
    .toEqual(["oauth_client", "oauth_code", "oauth_grant"]);
  // The token and its kept hash are untouched, and an ordinary token has no MCP sign-in binding.
  expect(store.apiTokens(null)).toEqual(tokens);
  expect(store.apiTokenSecret(minted.id)?.secretHash).toBe(minted.hash);
  expect(store.oauthGrant(minted.id)).toBeNull();
  // A grant must name a real token and client.
  expect(() => store!.handle.prepare("INSERT INTO oauth_code (hash, client, account, generation, access, projects_json, redirect_uri, resource, challenge, expires_at) VALUES ('h','c','alex',1,'admin','[]','r','r','c','t')").run()).toThrow(/CHECK/);
  // A second open changes nothing.
  store.close();
  const shape = () => new DatabaseSync(file).prepare("SELECT group_concat(sql, ';') AS ddl FROM sqlite_master WHERE name LIKE 'oauth_%'").get()?.["ddl"];
  const before = shape();
  store = openStore(file);
  store.close(); store = undefined;
  expect(shape()).toBe(before);
});
