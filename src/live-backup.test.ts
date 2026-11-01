/** The continuous copy (docs/plans/actors-lessons.md). Isolated fixtures only: production databases are never opened. */
import { afterEach, expect, test } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { databaseTag } from "./backup.js";
import { defaultLiveFolder, liveBackupPass, liveCopies, liveFolderProblem, pruneLiveCopies } from "./live-backup.js";
import { liveBackupState, openStore, SCHEMA_VERSION, setLiveBackupSettings, type Store } from "./store.js";
import { register } from "./runner.js";
import { liveCopyBackup } from "../scripts/deploy-phases.mjs";
import { existsSync } from "node:fs";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });
const fresh = () => { dir = realpathSync(mkdtempSync(join(tmpdir(), "so-live-"))); return dir; };

test("a due pass copies off the worker's thread, checks and hashes the copy, and records it as the latest", async () => {
  const file = join(fresh(), "orders.db");
  store = openStore(file);
  store.createTask({ id: "t-1", title: "kept in the copy" }, new Date());
  const now = new Date("2026-10-29T12:00:00.000Z");
  const made = await liveBackupPass(store, file, "test-holder", () => [], () => now);
  expect(made).toMatchObject({ ok: true });
  if (made === null || !made.ok) throw new Error("no copy");
  expect(made.copy.file.startsWith(join(dir, "backups", "live", `live-${databaseTag(file)}-2026-10-29-120000`))).toBe(true);
  expect(createHash("sha256").update(readFileSync(made.copy.file)).digest("hex")).toBe(made.copy.sha256);
  expect(made.copy.schemaVersion).toBe(SCHEMA_VERSION);
  const copy = new DatabaseSync(made.copy.file, { readOnly: true });
  try { expect(copy.prepare("SELECT title FROM task WHERE id = 't-1'").get()?.["title"]).toBe("kept in the copy"); } finally { copy.close(); }
  expect(liveBackupState(store).latest).toEqual({ ...made.copy, madeAt: now.toISOString() });
  // Not due again until the schedule says so; then due.
  expect(await liveBackupPass(store, file, "test-holder", () => [], () => new Date(now.getTime() + 4 * 60_000))).toBeNull();
  expect(await liveBackupPass(store, file, "test-holder", () => [], () => new Date(now.getTime() + 5 * 60_000))).toMatchObject({ ok: true });
});

test("the folder must be a plain, private folder of this user's, reached through no link, outside every project", async () => {
  const root = fresh();
  const real = join(root, "real");
  mkdirSync(real, { mode: 0o700 });
  expect(liveFolderProblem(real, [])).toBeNull();
  expect(liveFolderProblem(join(root, "not-yet"), [])).toBeNull();
  const link = join(root, "link");
  symlinkSync(real, link);
  expect(liveFolderProblem(link, [])).toMatch(/isn't a plain folder/);
  expect(liveFolderProblem(join(link, "inner"), [])).toBeNull(); // missing: made, then checked again before use
  mkdirSync(join(real, "inner"), { mode: 0o700 });
  expect(liveFolderProblem(join(link, "inner"), [])).toMatch(/goes through a link/);
  const open = join(root, "open");
  mkdirSync(open);
  chmodSync(open, 0o777);
  expect(liveFolderProblem(open, [])).toMatch(/Other users can write/);
  expect(liveFolderProblem(join(root, "project", "backups"), [join(root, "project")])).toMatch(/outside your projects/);
  writeFileSync(join(root, "a-file"), "");
  expect(liveFolderProblem(join(root, "a-file"), [])).toMatch(/isn't a plain folder/);

  // A refused folder is a recorded problem, and nothing is copied.
  const file = join(root, "orders.db");
  store = openStore(file);
  setLiveBackupSettings(store, { enabled: true, everyMinutes: 5, keep: 24, folder: link }, "alex", new Date());
  expect(await liveBackupPass(store, file, "test-holder", () => [])).toMatchObject({ ok: false, problem: expect.stringMatching(/protected backup folder/) });
  expect(liveBackupState(store)).toMatchObject({ latest: null, problem: expect.stringMatching(/protected backup folder/) });
});

test("retention keeps the newest K and the newest of each of the last seven days, and only this database's copies", () => {
  const folder = fresh();
  const tag = "0123abcd";
  const names: string[] = [];
  for (let day = 1; day <= 10; day++) for (const time of ["010000", "120000"]) names.push(`live-${tag}-2026-10-${String(day).padStart(2, "0")}-${time}.db`);
  for (const name of [...names, "live-ffffffff-2026-10-01-010000.db", "notes.txt"]) writeFileSync(join(folder, name), "");
  const removed = pruneLiveCopies(folder, tag, 3, new Date("2026-10-10T13:00:00.000Z"), join(folder, names[0]!));
  const left = liveCopies(folder, tag).map(one => one.name);
  // Newest 3 (10th noon, 10th 01:00, 9th noon), the newest of each day from the 4th, and the protected oldest.
  expect(left).toEqual([
    `live-${tag}-2026-10-10-120000.db`, `live-${tag}-2026-10-10-010000.db`, `live-${tag}-2026-10-09-120000.db`,
    ...[8, 7, 6, 5, 4].map(day => `live-${tag}-2026-10-0${day}-120000.db`), `live-${tag}-2026-10-01-010000.db`,
  ]);
  expect(removed).toBe(20 - left.length);
  expect(liveCopies(folder, "ffffffff")).toHaveLength(1);
});

test("a deploy uses the latest copy only when fresh, unchanged, on its schema and equal to the paused database", async () => {
  const file = join(fresh(), "orders.db");
  store = openStore(file);
  store.createTask({ id: "t-1", title: "before the copy" }, new Date());
  register(store, { name: "w-1", host: "here", now: new Date() });
  const made = await liveBackupPass(store, file, "test-holder", () => []);
  if (made === null || !made.ok) throw new Error("no copy");
  const madeAt = Date.parse(made.copy.madeAt);
  // The update pause is triggers on the live database: the copy gets the same ones.
  store.handle.exec("CREATE TRIGGER so_test_pause BEFORE INSERT ON task BEGIN SELECT RAISE(ABORT, 'paused'); END");
  // A heartbeat since the copy is a liveness row: the copy still stands for the paused database.
  store.handle.prepare("UPDATE runner SET heartbeat_at = ? WHERE name = 'w-1'").run(new Date(madeAt + 30_000).toISOString());
  const attempt = (name: string, at: number, schema = SCHEMA_VERSION) => {
    const r: Record<string, unknown> = { backup: join(dir, `${name}.db`), schema };
    return { r, before: liveCopyBackup(file, r, () => {}, at) };
  };
  const used = attempt("used", madeAt + 60_000);
  expect(used.before).not.toBeNull();
  expect(used.r["liveCopy"]).toEqual({ file: made.copy.file, sha256: made.copy.sha256, madeAt: made.copy.madeAt });
  const copy = new DatabaseSync(String(used.r["backup"]), { readOnly: true });
  try { expect(copy.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'so_test_pause'").get()).toBeDefined(); } finally { copy.close(); }

  // Too old for its own schedule, another schema: not used, and nothing left behind.
  for (const refused of [attempt("stale", madeAt + 6 * 60_000), attempt("schema", madeAt + 60_000, SCHEMA_VERSION - 1)]) {
    expect(refused.before).toBeNull();
    expect(existsSync(String(refused.r["backup"]))).toBe(false);
  }
  // A row written since the copy (anything but liveness) means it isn't the paused database.
  store.handle.exec("DROP TRIGGER so_test_pause");
  store.createTask({ id: "t-2", title: "after the copy" }, new Date());
  const differs = attempt("differs", madeAt + 60_000);
  expect(differs.before).toBeNull();
  expect(existsSync(String(differs.r["backup"]))).toBe(false);
  // Bytes changed since they were verified: never used.
  store.handle.exec("DELETE FROM task WHERE id = 't-2'");
  writeFileSync(made.copy.file, Buffer.concat([readFileSync(made.copy.file), Buffer.from("x")]));
  expect(attempt("changed", madeAt + 60_000).before).toBeNull();
});

test("a custom copy folder outside the permanent build fence is refused", async () => {
  const root = fresh(), file = join(root, "orders.db"), folder = join(root, "agent-readable");
  mkdirSync(folder, { mode: 0o700 });
  store = openStore(file);
  setLiveBackupSettings(store, { enabled: true, everyMinutes: 5, keep: 24, folder }, "alex", new Date());
  expect(await liveBackupPass(store, file, "test-holder", () => [])).toMatchObject({ ok: false, problem: expect.stringMatching(/protected backup folder/) });
  expect(liveCopies(folder, databaseTag(file))).toEqual([]);
});

test("a database alias keeps its copies under the actual database's fenced namespace", () => {
  const root = fresh(), state = join(root, "actual");
  mkdirSync(state);
  const file = join(state, "orders.db"), alias = join(root, "alias.db");
  store = openStore(file); symlinkSync(file, alias);
  expect(defaultLiveFolder(alias)).toBe(defaultLiveFolder(file));
});
