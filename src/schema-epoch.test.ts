import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { CREDENTIAL_TABLE, openStore, openStoreNoMigrate, readSchemaVersion, SCHEMA_VERSION, Store, type Database } from "./store.js";
import { mintCoordinator } from "./coordinator.js";
import { MODERN, serveMcp } from "./mcp.js";
import { baselineFile } from "../test/baseline.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => Database };

const directories: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "epoch-"));
  directories.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * The migration epoch + the non-migrating door (MCP gateway spec v6,
 * Codex rounds 3/5): the MCP server never creates or migrates, and a
 * migration mid-flight is VISIBLE (negative version) rather than a
 * silently half-shaped database a version re-read would bless.
 */
describe("the non-migrating door", () => {
  test("an absent database refuses in words — it never creates one", () => {
    const dir = scratch();
    const answer = openStoreNoMigrate(join(dir, "never-made.db"));
    expect(answer).toMatchObject({ ok: false, reason: "missing" });
  });

  test("a current database opens; a mid-flight epoch refuses with the sentinel named", () => {
    const dir = scratch();
    const file = join(dir, "orders.db");
    openStore(file).close();

    const opened = openStoreNoMigrate(file);
    expect(opened).toMatchObject({ ok: true });
    if (!opened.ok) throw new Error("unreachable");
    expect(opened.store.schemaCurrent()).toBe(true);
    opened.store.close();

    // A real predecessor shape (the v107 baseline, as 0.5.0 made it) with a
    // committed epoch, as left by a migrator that died before its first DDL.
    // No newer fields are relabeled as an older schema.
    const interrupted = join(dir, "interrupted.db");
    baselineFile(interrupted, -107);
    const prior = new Store(new DatabaseSync(interrupted));
    expect(prior.schemaCurrent()).toBe(false);
    prior.close();

    const refused = openStoreNoMigrate(interrupted);
    expect(refused).toMatchObject({ ok: false, reason: "version" });
    if (refused.ok) throw new Error("unreachable");
    expect(refused.message).toContain("mid-flight");

    // The real migrator resumes and clears the sentinel; the door opens.
    openStore(interrupted).close();
    const recovered = openStoreNoMigrate(interrupted);
    expect(recovered).toMatchObject({ ok: true });
    if (recovered.ok) recovered.store.close();
  });

  test.each(["status", "file_proposal"])("MCP %s refuses while the real migrator is paused after its first DDL", tool => {
    const dir = scratch();
    const file = join(dir, "orders.db");
    baselineFile(file);
    // Model the already-running 0.5.0 build's version constant (v107),
    // keeping the real strict reader, MCP dispatcher, credential
    // verification, and SQL connection. Production gains no
    // version-override or test hook.
    class V107Reader extends Store {
      override schemaCurrent(): boolean {
        const version = readSchemaVersion(this.handle);
        return version.ok && version.version === 107;
      }
    }
    const reader = new V107Reader(new DatabaseSync(file));
    // This build's coordinator door reads the one credential table (v118); the reader's file has it beside its own.
    reader.handle.exec(CREDENTIAL_TABLE);
    let migrated: Store | undefined;
    try {
      const now = new Date("2026-09-17T12:00:00Z");
      const minted = mintCoordinator(reader, { name: "epoch-reader", repos: ["/repo/app"], by: "alex", now });
      if (!minted.ok) throw new Error("fixture credential failed");
      const output: Record<string, unknown>[] = [];
      let receive: (line: string) => void = () => {};
      let exitCode: number | null = null;
      expect(serveMcp(reader, minted.token, {
        onLine: handler => { receive = handler; }, onEof: () => {},
        write: line => output.push(JSON.parse(line)), log: () => {}, exit: code => { exitCode = code; },
      }, () => now, ["/repo/app"])).toEqual({ ok: true });
      const meta = { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientCapabilities": {} };
      receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { _meta: meta, name: "status", arguments: {} } }));
      expect(output[0]).toHaveProperty("result");
      expect(exitCode).toBeNull();
      const tasksBefore = reader.handle.prepare("SELECT COUNT(*) AS n FROM task").get();
      let paused = false;
      migrated = openStore(file, { connect: path => {
        const real = new DatabaseSync(path);
        return {
          prepare: sql => real.prepare(sql), close: () => real.close(), enableDefensive: (on: boolean) => real.enableDefensive?.(on),
          exec: sql => {
            const firstDdl = sql.indexOf("CREATE TABLE");
            if (!paused && firstDdl !== -1) {
              const boundary = sql.indexOf(";", firstDdl) + 1;
              expect(boundary).toBeGreaterThan(firstDdl);
              real.exec(sql.slice(0, boundary));
              paused = true;
              // Independent connection: the marker must already be
              // committed while the migrator has completed just one DDL.
              expect(readSchemaVersion(reader.handle)).toMatchObject({ ok: true, version: -107 });
              receive(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
                _meta: meta, name: tool, arguments: tool === "status" ? {} : {
                  repo: "/repo/app", title: "Must not file during migration", idempotency_key: "epoch-file-refused",
                },
              } }));
              expect(output[1]).toMatchObject({ id: 2, error: { code: -32000 } });
              expect(output[1]).not.toHaveProperty("result");
              expect(exitCode).toBe(0);
              expect(reader.handle.prepare("SELECT COUNT(*) AS n FROM task").get()).toEqual(tasksBefore);
              expect(reader.handle.prepare("SELECT 1 FROM mcp_idempotency WHERE cid = ?").get(minted.cid)).toBeUndefined();
              real.exec(sql.slice(boundary));
              return;
            }
            real.exec(sql);
          },
        };
      } });
      expect(paused).toBe(true);
      expect(readSchemaVersion(migrated.handle)).toMatchObject({ ok: true, version: SCHEMA_VERSION });
      expect(migrated.handle.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      migrated?.close();
      reader.close();
    }
  });

  test("a version this build does not speak refuses without touching it", () => {
    const dir = scratch();
    const file = join(dir, "orders.db");
    openStore(file).close();
    const opened = openStoreNoMigrate(file);
    if (!opened.ok) throw new Error("setup failed");
    opened.store.handle.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION + 5);
    opened.store.close();
    const refused = openStoreNoMigrate(file);
    expect(refused).toMatchObject({ ok: false, reason: "version" });
  });
});
