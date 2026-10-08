/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

test.each([90, -90])("v%s: flows and their cards stay as they were, and each card can keep an email conversation", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v91-"));
  const file = join(dir, "state.db");
  const first = openStore(file);
  const flow = first.createFlow({ repo: "/r", name: "Replies", definitionJson: JSON.stringify({ version: 1, start: "inbox", stages: [{ id: "inbox", title: "Inbox", kind: "inbox", zone: {}, next: null, onFail: null }] }), by: "alex" }, new Date("2026-09-20T00:00:00.000Z"));
  const card = first.addFlowCard({ flow, title: "Refund for order 42?", description: "From: Priya", stage: "inbox", by: "alex" }, new Date("2026-09-20T00:00:00.000Z"));
  first.close();
  // The v90 shape: no conversation tables.
  const db = new DatabaseSync(file);
  db.exec("DROP INDEX IF EXISTS flow_mail_card; DROP TABLE flow_mail; DROP TABLE flow_mail_watch");
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  db.close();
  store = openStore(file);
  expect(SCHEMA_VERSION).toBe(115);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.version).toBe(115);
  expect(store.getFlowCard(card)).toMatchObject({ title: "Refund for order 42?", stage: "inbox", state: "active", entry: 1 });
  expect(store.flowMailOf(card)).toEqual([]);
  expect(store.flowMailWatch()).toEqual({ cursor: null, nextAt: null, failures: 0, lastOutcome: null });
  const now = new Date("2026-09-25T10:00:00.000Z");
  expect(store.recordFlowMail({ messageId: "<a1@shop.example>", card, direction: "sent", address: "Priya@Example.com" }, now)).toBe(true);
  expect(store.recordFlowMail({ messageId: "<a1@shop.example>", card, direction: "sent", address: "priya@example.com" }, now)).toBe(false);
  store.close(); store = openStore(file);
  expect(store.flowMailOf(card)).toEqual([{ messageId: "<a1@shop.example>", direction: "sent", address: "priya@example.com", at: now.toISOString() }]);
  expect(store.flowConversationsOpen()).toBe(true);
});
