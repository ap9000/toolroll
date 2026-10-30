/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BUILT_IN, latencyTimelines, liveBackupState, openStore, recordLatencyTimeline, SCHEMA_VERSION, TIMELINES_KEPT, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, type Store } from "./store.js";
import { changedHistory, historySnapshot } from "./toolroll-update.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

test.each([136, -136])("v%s: lifecycle, latency timelines and the continuous copy are added; no saved row changes", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v137-"));
  const file = join(dir, "state.db");
  const now = new Date("2026-10-29T12:00:00.000Z");
  const first = openStore(file);
  first.upsertProject("/projects/shop", "shop", now);
  first.createTask({ id: "t-1", title: "a task" }, now);
  first.refFor(BUILT_IN, "t-1");
  first.sealLedger();
  const chain = first.ledgerChain({ full: true });
  first.close();
  // The v136 shape: none of the three tables.
  const db = new DatabaseSync(file);
  for (const table of ["service_lifecycle", "latency_timeline", "live_backup"]) db.exec(`DROP TABLE ${table}`);
  db.exec("ALTER TABLE task_scope DROP COLUMN release_check_json"); // v138's column, so v136 climbs through both
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  const before = historySnapshot(db);
  db.close();

  expect(updateSafeSchema(136)).toBe(true);
  expect(UPDATE_SAFE_MIGRATIONS).toContain(137);
  expect(SCHEMA_VERSION).toBe(138);
  store = openStore(file);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(138);
  for (const table of ["service_lifecycle", "latency_timeline", "live_backup"]) expect(store.handle.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"]).toBe(0);
  expect(store.handle.prepare("SELECT count(*) AS n FROM pragma_table_info('task_scope') WHERE name = 'release_check_json'").get()?.["n"]).toBe(1);
  // Absent settings read as the defaults: every 5 minutes, keep 24, beside the database.
  expect(liveBackupState(store)).toEqual({ settings: { enabled: true, everyMinutes: 5, keep: 24, folder: null }, latest: null, triedAt: null, problem: null });
  expect(store.handle.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(store.ledgerChain({ full: true })).toMatchObject({ ok: true, through: chain.through, head: chain.head });
  store.close();
  store = undefined;
  const after = new DatabaseSync(file);
  try { expect(changedHistory(after, before)).toEqual([]); } finally { after.close(); }
});

test("timelines stay bounded: milestones capped and cleaned, each kind pruned to the newest", () => {
  store = openStore(":memory:");
  const at = new Date("2026-10-29T12:00:00.000Z");
  const milestones = Array.from({ length: 60 }, (_, index) => ({ name: `step\u0007 ${index}`, ms: index * 10.4, detail: "x".repeat(400) }));
  recordLatencyTimeline(store, { kind: "console", subject: "task.page", startedAt: at, totalMs: 1234.6, milestones }, at);
  const [one] = latencyTimelines(store, { kind: "console" });
  expect(one!.milestones).toHaveLength(40);
  expect(one!.milestones[0]).toEqual({ name: "step  0", ms: 0, detail: "x".repeat(160) });
  expect(one!.milestones.at(-1)!.name).toBe("step  59");
  expect(one!.totalMs).toBe(1235);
  for (let n = 0; n < TIMELINES_KEPT + 5; n++) recordLatencyTimeline(store, { kind: "console", subject: "chat.page", startedAt: at, totalMs: 1, milestones: [] }, at);
  recordLatencyTimeline(store, { kind: "deploy", subject: "abc1234", taskId: "t-1", startedAt: at, totalMs: 5, milestones: [] }, at);
  expect(store.handle.prepare("SELECT count(*) AS n FROM latency_timeline WHERE kind = 'console'").get()?.["n"]).toBe(TIMELINES_KEPT);
  // A timeline older than the kept days goes whatever the count.
  const fortnight = new Date(at.getTime() + 15 * 86_400_000);
  recordLatencyTimeline(store, { kind: "deploy", subject: "def5678", taskId: "t-1", startedAt: fortnight, totalMs: 5, milestones: [] }, fortnight);
  expect(latencyTimelines(store, { taskId: "t-1" }).map(row => row.subject)).toEqual(["def5678"]);
});
