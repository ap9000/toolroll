/**
 * Backups (sprint 8): scheduled online backups that keep the newest N and
 * record how each went; `backup now|list` and Settings → Backups; and a
 * restore that refuses while Toolroll runs, checks the schema version
 * and the ledger chain, keeps the current database first, and dry-runs.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { runOperate } from "./operate.js";
import { backupDue, backupFiles, backupNow, backupOwner, backupPass, databaseTag, onlineCopy, pruneBackups, restoreDatabase } from "./backup.js";

let dir: string, file: string, store: Store;
const NOW = new Date("2026-09-28T05:00:00.000Z");
const HOUR = 3_600_000;
const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-backup-"));
  file = join(dir, "orders.db");
  store = openStore(file);
});
afterEach(() => { try { store.close(); } catch { /* a test closed it */ } rmSync(dir, { recursive: true, force: true }); });

const task = (id: string) => store.createTask({ id, title: id }, NOW);
const tasksIn = (path: string) => { const db = new DatabaseSync(path); try { return db.prepare("SELECT id FROM task ORDER BY id").all().map(row => String(row["id"])); } finally { db.close(); } };
const folder = () => join(dir, "backups");

test("a backup is an online copy: running work carries on, the copy is checked, private, and holds only the database", async () => {
  task("before");
  // A secret kept beside the database (as keys and sign-in files are) never goes into a backup.
  writeFileSync(join(dir, "anthropic-key"), ["sk", "ant", "secret", "value"].join("-"), { mode: 0o600 });
  // Another connection is mid-write: the copy neither waits for it nor takes its uncommitted work.
  const writer = new DatabaseSync(file);
  writer.exec("BEGIN IMMEDIATE");
  writer.prepare("INSERT INTO backup_lease (id, holder) VALUES (1, 'uncommitted')").run();
  const copy = join(dir, "copy.db");
  try { await onlineCopy(file, copy); } finally { writer.exec("ROLLBACK"); writer.close(); }
  const copied = new DatabaseSync(copy);
  try { expect(copied.prepare("SELECT COUNT(*) AS n FROM backup_lease").get()).toMatchObject({ n: 0 }); } finally { copied.close(); }

  const made = await backupNow(store, file, "manual", () => NOW);
  expect(made).toMatchObject({ ok: true, removed: 0 });
  if (!made.ok) throw new Error(made.error);
  expect(made.file).toBe(join(folder(), `standing-orders-${databaseTag(file)}-2026-09-28-050000.db`));
  expect(readdirSync(folder())).toEqual([`standing-orders-${databaseTag(file)}-2026-09-28-050000.db`]);
  expect(statSync(made.file).mode & 0o777).toBe(0o600);
  expect(tasksIn(made.file)).toEqual(["before"]);
  expect(readFileSync(made.file).includes(["sk", "ant", "secret", "value"].join("-"))).toBe(false);
  expect(store.backupRuns()).toMatchObject([{ id: made.id, trigger: "manual", ok: true, file: made.file, schemaVersion: SCHEMA_VERSION, error: null }]);
});

test("a backup first checkpoints the verified chain head (the copy carries it), once per head, and never over a broken chain", async () => {
  const act = (action: string) => store.recordAction({ at: NOW.toISOString(), actor: "alex", repo: null, taskId: null, runId: null, action, outcome: "done", source: "policy" });
  const checkpointsIn = (path: string) => { const db = new DatabaseSync(path); try { return db.prepare("SELECT through, hash, by FROM ledger_checkpoint ORDER BY id").all().map(row => ({ ...row })); } finally { db.close(); } };
  act("one"); act("two");
  const entries = store.handle.prepare("SELECT COUNT(*) AS n FROM action_ledger").get()!["n"];
  const first = await backupNow(store, file, "manual", () => NOW);
  if (!first.ok) throw new Error(first.error);
  const head = store.ledgerChain({ full: true });
  expect(first.checkpoint).toEqual({ through: head.through, hash: head.head });
  expect(store.ledgerCheckpoints()).toMatchObject([{ through: head.through, hash: head.head, by: "system" }]);
  expect(checkpointsIn(first.file)).toEqual([{ through: head.through, hash: head.head, by: "system" }]);
  // An automatic checkpoint writes no ledger entry: the next backup has nothing new to checkpoint.
  expect(store.handle.prepare("SELECT COUNT(*) AS n FROM action_ledger").get()!["n"]).toBe(entries);
  const second = await backupNow(store, file, "manual", () => at(1));
  expect(second).toMatchObject({ ok: true, checkpoint: null });
  expect(store.ledgerCheckpoints()).toHaveLength(1);

  // A broken chain gets no checkpoint; the backup still goes ahead and says why.
  act("three");
  store.handle.exec("DROP TRIGGER action_ledger_no_update");
  store.handle.exec("UPDATE action_ledger SET actor = 'mallory' WHERE action = 'two'");
  const third = await backupNow(store, file, "manual", () => at(2));
  expect(third).toMatchObject({ ok: true, checkpoint: { problem: expect.stringContaining("was changed after it was sealed") } });
  expect(store.ledgerCheckpoints()).toHaveLength(1);
  // The manual checkpoint is the same method, and refuses the same way.
  expect(store.ledgerCheckpoint("alex", at(2))).toMatchObject({ problem: expect.stringContaining("was changed after it was sealed") });
});

test("the newest N are kept; nothing else in the folder is touched", async () => {
  store.setBackupSettings({ enabled: true, everyHours: 1, keep: 3, folder: null }, "alex", NOW);
  const made: string[] = [];
  for (let hour = 0; hour < 5; hour++) {
    const one = await backupNow(store, file, "scheduled", () => at(hour));
    if (!one.ok) throw new Error(one.error);
    made.push(one.file);
  }
  writeFileSync(join(folder(), "notes.txt"), "mine");
  writeFileSync(join(folder(), "before-restore-2026-09-01-000000-abc123.db"), "kept");
  expect(backupFiles(folder(), backupOwner(store, file)).map(one => one.path)).toEqual(made.slice(2).reverse());
  expect(store.backupRuns().map(run => run.removed)).toEqual([1, 1, 0, 0, 0]);
  expect(pruneBackups(folder(), 1, backupOwner(store, file))).toBe(2);
  expect(readdirSync(folder()).sort()).toEqual(["before-restore-2026-09-01-000000-abc123.db", "notes.txt", `standing-orders-${databaseTag(file)}-2026-09-28-090000.db`]);
});

test("two databases backing up into one folder each keep their own newest N and never delete the other's", async () => {
  const shared = join(dir, "shared");
  const otherFile = join(dir, "other", "orders.db");
  mkdirSync(dirname(otherFile));
  const other = openStore(otherFile);
  try {
    expect(databaseTag(otherFile)).not.toBe(databaseTag(file));
    store.setBackupSettings({ enabled: true, everyHours: 1, keep: 2, folder: shared }, "alex", NOW);
    other.setBackupSettings({ enabled: true, everyHours: 1, keep: 3, folder: shared }, "alex", NOW);
    const mine: string[] = [], theirs: string[] = [];
    for (let hour = 0; hour < 5; hour++) {
      const one = await backupNow(store, file, "scheduled", () => at(hour));
      const two = await backupNow(other, otherFile, "scheduled", () => at(hour));
      if (!one.ok || !two.ok) throw new Error("backup");
      mine.push(one.file);
      theirs.push(two.file);
    }
    expect(backupFiles(shared, backupOwner(store, file)).map(one => one.path)).toEqual(mine.slice(3).reverse());
    expect(backupFiles(shared, backupOwner(other, otherFile)).map(one => one.path)).toEqual(theirs.slice(2).reverse());
    expect(readdirSync(shared).sort()).toEqual([...mine.slice(3), ...theirs.slice(2)].map(path => basename(path)).sort());
  } finally { other.close(); }
});

test("backups made before they were tagged: this database's history claims its own; any other untagged backup is never its own, so never pruned", async () => {
  const shared = folder();
  mkdirSync(shared);
  const legacy = (stamp: string) => { const path = join(shared, `standing-orders-${stamp}.db`); writeFileSync(path, "old"); return path; };
  const ours = legacy("2026-09-01-000000");
  const unknown = legacy("2026-09-02-000000");
  store.handle.prepare("INSERT INTO backup_run (trigger, started_at, finished_at, ok, file) VALUES ('scheduled', ?, ?, 1, ?)").run(NOW.toISOString(), NOW.toISOString(), ours);
  // Even alone in the folder, an untagged backup its history doesn't record may be another database's (one that hasn't
  // tagged a backup yet): it isn't this database's to prune.
  expect(backupFiles(shared, backupOwner(store, file)).map(one => one.path)).toEqual([ours]);
  const otherTag = databaseTag(join(dir, "other.db"));
  writeFileSync(join(shared, `standing-orders-${otherTag}-2026-09-03-000000.db`), "theirs");
  expect(backupFiles(shared, backupOwner(store, file)).map(one => one.path)).toEqual([ours]);
  store.setBackupSettings({ enabled: true, everyHours: 1, keep: 1, folder: null }, "alex", NOW);
  const made = await backupNow(store, file, "manual", () => NOW);
  expect(made).toMatchObject({ ok: true, removed: 1 });
  expect(readdirSync(shared).sort()).toEqual([basename(unknown), `standing-orders-${databaseTag(file)}-2026-09-28-050000.db`, `standing-orders-${otherTag}-2026-09-03-000000.db`].sort());
});

test("a failed backup is recorded and notified, and the schedule retries within the hour", async () => {
  // The folder can't be made: a file is in the way.
  writeFileSync(join(dir, "blocked"), "");
  store.setBackupSettings({ enabled: true, everyHours: 24, keep: 7, folder: join(dir, "blocked", "backups") }, "alex", NOW);
  const failed = await backupPass(store, file, "console-1", () => NOW);
  expect(failed).toMatchObject({ ok: false });
  expect(store.backupRuns()[0]).toMatchObject({ trigger: "scheduled", ok: false, file: null });
  expect(store.backupRuns()[0]!.error).toBeTruthy();
  expect(store.handle.prepare("SELECT subject FROM notification WHERE kind = 'backup-failed'").all()).toEqual([expect.objectContaining({ subject: "A backup failed" })]);
  expect(backupDue(store, at(0.5))).toBe(false);
  expect(backupDue(store, at(1))).toBe(true);
});

test("the schedule: one console holds the lease, backs up when due, and not again until the interval has passed", async () => {
  expect(await backupPass(store, file, "console-1", () => NOW)).toMatchObject({ ok: true });
  expect(await backupPass(store, file, "console-1", () => at(1))).toBeNull();
  // Another console can't take the lease while the first holds it.
  expect(await backupPass(store, file, "console-2", () => at(1.01))).toBeNull();
  expect(await backupPass(store, file, "console-1", () => at(24))).toMatchObject({ ok: true });
  store.setBackupSettings({ enabled: false, everyHours: 24, keep: 7, folder: null }, "alex", NOW);
  expect(await backupPass(store, file, "console-1", () => at(100))).toBeNull();
  expect(store.backupRuns().map(run => run.trigger)).toEqual(["scheduled", "scheduled"]);
  // Each settings change is in the ledger, before → after.
  const changes = store.actionLedger({ repos: null, instance: true, limit: 20 }).filter(one => one.action === "backup settings changed").map(one => one.detail);
  expect(changes).toEqual([`every 24 hours, keep 7, the default folder → off, keep 7, the default folder`]);
});

test("backup now and backup list on the command line", async () => {
  store.close();
  let lines: string[] = [];
  const run = async (command: string, argv: string[]) => { lines = []; const code = await runOperate(command, argv, line => { lines.push(line); }, { databaseFile: file, now: NOW }); return { code, out: lines.join("\n") }; };
  expect((await run("backup", ["list"])).out).toContain("No backup has run yet.");
  const now = await run("backup", ["now", "--json"]);
  expect(now.code).toBe(0);
  expect(JSON.parse(now.out)).toMatchObject({ ok: true, command: "backup now", backup: { ok: true } });
  const list = await run("backup", ["list"]);
  expect(list.out).toContain("Every 24 hours, keeping the newest 7");
  expect(list.out).toMatch(/Last backup .* UTC: succeeded\./);
  expect(list.out).toContain(`standing-orders-${databaseTag(file)}-`);
  // Another database's backup in the same folder isn't listed.
  const theirs = `standing-orders-${databaseTag(join(dir, "other.db"))}-2026-09-28-040000.db`;
  writeFileSync(join(folder(), theirs), "theirs");
  const listed = await run("backup", ["list", "--json"]);
  expect(JSON.parse(listed.out).files.map((one: { name: string }) => one.name)).toEqual([expect.stringContaining(databaseTag(file))]);
  expect((await run("backup", ["list"])).out).not.toContain(theirs);
  expect((await run("backup", ["sideways"])).code).toBe(2);
  store = openStore(file);
});

/** A backup to restore from, made after "kept" and before "later". */
async function aBackup(): Promise<string> {
  task("kept");
  store.recordAction({ at: NOW.toISOString(), actor: "alex", repo: null, taskId: null, runId: null, action: "something", outcome: "done", source: "policy" });
  store.ledgerChain({ full: true });
  const made = await backupNow(store, file, "manual", () => NOW);
  if (!made.ok) throw new Error(made.error);
  task("later");
  return made.file;
}
/** A copy of `source` changed by `change`, for a refusal. */
function altered(source: string, name: string, change: (db: DatabaseSync) => void): string {
  const target = join(dir, name);
  writeFileSync(target, readFileSync(source));
  const db = new DatabaseSync(target);
  try { change(db); } finally { db.close(); }
  return target;
}

test("restore: a dry run checks and changes nothing; a restore keeps the current database first and records itself", async () => {
  const backup = await aBackup();
  store.close();
  const dry = await restoreDatabase({ databaseFile: file, file: backup, dryRun: true, now: at(1) });
  expect(dry).toMatchObject({ ok: true, dryRun: true, refusals: [], schemaVersion: SCHEMA_VERSION, savedAs: null });
  expect(dry.ledger!.entries).toBeGreaterThan(0);
  expect(tasksIn(file)).toEqual(["kept", "later"]);
  expect(readdirSync(dir).filter(name => name.startsWith(".restore-"))).toEqual([]);

  const done = await restoreDatabase({ databaseFile: file, file: backup, dryRun: false, now: at(1) });
  expect(done).toMatchObject({ ok: true, dryRun: false, refusals: [] });
  expect(done.savedAs).toMatch(/backups\/before-restore-2026-09-28-060000-[0-9a-f]{6}\.db$/);
  expect(tasksIn(done.savedAs!)).toEqual(["kept", "later"]);
  expect(tasksIn(file)).toEqual(["kept"]);
  expect(existsSync(`${file}-wal`) && statSync(`${file}-wal`).size > 0).toBe(false);
  // Retention never counts the copy kept before a restore.
  store = openStore(file);
  expect(backupFiles(join(dir, "backups"), backupOwner(store, file)).map(one => one.path)).toEqual([backup]);
  expect(store.actionLedger({ repos: null, instance: true, limit: 5 })[0]).toMatchObject({ action: "database restored", outcome: "restored" });
  expect(store.ledgerChain({ full: true }).ok).toBe(true);
});

test("restore refuses, changing nothing: while the console or a worker runs, a newer or unknown schema, a broken ledger chain, and a file that isn't a backup", async () => {
  const backup = await aBackup();
  const refusal = async (path: string, now = at(1)) => {
    const report = await restoreDatabase({ databaseFile: file, file: path, dryRun: false, now });
    expect(report.ok).toBe(false);
    expect(report.savedAs).toBeNull();
    return report.refusals.map(one => one.reason);
  };
  const unchanged = () => {
    expect(tasksIn(file)).toEqual(["kept", "later"]);
    expect(readdirSync(join(dir, "backups")).filter(name => name.startsWith("before-restore"))).toEqual([]);
    expect(readdirSync(dir).filter(name => name.startsWith(".restore-"))).toEqual([]);
  };

  // The console is running: its backup loop holds the lease.
  expect(store.holdBackupLease("console-1", at(1), at(1.05))).toBe(true);
  expect(await refusal(backup)).toEqual(["running"]);
  const words = (await restoreDatabase({ databaseFile: file, file: backup, dryRun: true, now: at(1) })).refusals[0]!.words;
  expect(words).toContain("Toolroll is running (the console)");
  store.releaseBackupLease("console-1");
  // A worker's watch loop holds a lease, or a worker heartbeat just now.
  store.handle.prepare("INSERT INTO watch_lease (runner, repo, owner, generation, started_at, expires_at, heartbeat_at) VALUES ('b1', '/repo', 'o', 1, ?, ?, ?)").run(at(1).toISOString(), at(1.1).toISOString(), at(1).toISOString());
  expect(await refusal(backup)).toEqual(["running"]);
  store.handle.exec("DELETE FROM watch_lease");
  store.handle.prepare("INSERT INTO runner (name, host, credential_hash, capacity, registered_at, heartbeat_at) VALUES ('b2', 'here', 'h', 1, ?, ?)").run(NOW.toISOString(), at(1).toISOString());
  expect(await refusal(backup)).toEqual(["running"]);
  // Once it stops heartbeating, it isn't running.
  expect(await restoreDatabase({ databaseFile: file, file: backup, dryRun: true, now: at(2) })).toMatchObject({ ok: true });
  unchanged();

  const later = at(2);
  expect(await refusal(altered(backup, "newer.db", db => db.exec(`UPDATE schema_version SET version = ${SCHEMA_VERSION + 1}`)), later)).toEqual(["schema"]);
  expect(await refusal(altered(backup, "older.db", db => db.exec("UPDATE schema_version SET version = 90")), later)).toEqual(["schema"]);
  expect(await refusal(altered(backup, "unversioned.db", db => db.exec("DROP TABLE schema_version")), later)).toEqual(["schema"]);
  expect(await refusal(altered(backup, "tampered.db", db => {
    db.exec("DROP TRIGGER action_ledger_no_update");
    db.exec("UPDATE action_ledger SET actor = 'mallory' WHERE action = 'something'");
  }), later)).toEqual(["ledger"]);
  writeFileSync(join(dir, "notes.db"), "not a database at all, just some words");
  expect(await refusal(join(dir, "notes.db"), later)).toEqual(["unreadable"]);
  expect(await refusal(join(dir, "missing.db"), later)).toEqual(["not-found"]);
  expect(await refusal(file, later)).toEqual(["same-file"]);
  unchanged();
});

test("restore on the command line: usage, refusals and a dry run", async () => {
  const backup = await aBackup();
  store.close();
  let lines: string[] = [];
  const run = async (argv: string[]) => { lines = []; const code = await runOperate("restore", argv, line => { lines.push(line); }, { databaseFile: file, now: at(1) }); return { code, out: lines.join("\n") }; };
  expect((await run([])).code).toBe(2);
  const dry = await run([backup, "--dry-run"]);
  expect(dry).toMatchObject({ code: 0 });
  expect(dry.out).toContain("Dry run:");
  expect(dry.out).toContain("Nothing was changed.");
  const refused = await run([join(dir, "missing.db"), "--json"]);
  expect(refused.code).toBe(3);
  expect(JSON.parse(refused.out)).toMatchObject({ ok: false, reason: "not-found" });
  const done = await run([backup]);
  expect(done.code).toBe(0);
  expect(done.out).toContain("The database as it was is kept at");
  expect(tasksIn(file)).toEqual(["kept"]);
  store = openStore(file);
});

test("Settings → Backups is an instance operator's: the last backup and its result, back up now, and a schedule change with a step-up", async () => {
  const alex = addApprover(store, "alex", NOW);
  if (!alex.ok) throw new Error("alex");
  const sam = addApprover(store, "sam", NOW, { name: "alex", token: alex.token });
  if (!sam.ok) throw new Error("sam");
  expect(store.setAccountProjects("sam", ["/repo/shop"], "alex", NOW)).toEqual({ ok: true });
  const server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo: "/repo/shop" });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const signIn = async (name: string, token: string) => (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name, token }), redirect: "manual" }))
      .headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
    const cookie = await signIn("alex", alex.token);
    const page = async () => (await fetch(`${base}/settings/backups`, { headers: { cookie } })).text();
    const first = await page();
    expect(first).toContain("<h1>Backups</h1>");
    expect(first).toContain("No backups yet");
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(first)![1]!;
    const post = (path: string, fields: Record<string, string>) => fetch(`${base}${path}`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, ...fields }), redirect: "manual" });

    expect((await post("/settings/backups/now", {})).headers.get("location")).toContain("said=");
    const after = await page();
    expect(after).toContain('data-backup-state="ok"');
    expect(after).toContain("Backed up ");
    // Only this database's backups: another database's in the same folder isn't shown.
    expect(after).toContain(`standing-orders-${databaseTag(file)}-`);
    const theirs = `standing-orders-${databaseTag(join(dir, "other.db"))}-2026-09-28-040000.db`;
    writeFileSync(join(folder(), theirs), "theirs");
    expect(await page()).not.toContain(theirs);

    // A failed backup is what the page leads with.
    store.handle.prepare("INSERT INTO backup_run (trigger, started_at, finished_at, ok, error) VALUES ('scheduled', ?, ?, 0, 'disk full')").run(new Date().toISOString(), new Date().toISOString());
    const failing = await page();
    expect(failing).toContain('data-backup-state="failed"');
    expect(failing).toContain("disk full");

    expect((await post("/settings/backups", { every: "6", keep: "3", folder: "", password: "wrong" })).headers.get("location")).toContain("problem=");
    expect(store.backupSettings()).toMatchObject({ everyHours: 24, keep: 7 });
    expect((await post("/settings/backups", { every: "6", keep: "3", folder: "/repo/shop/backups", password: alex.token })).headers.get("location")).toContain("problem=");
    expect((await post("/settings/backups", { every: "5", keep: "3", folder: "", password: alex.token })).headers.get("location")).toContain("problem=");
    expect((await post("/settings/backups", { every: "6", keep: "3", folder: join(dir, "elsewhere"), password: alex.token })).headers.get("location")).toContain("said=");
    expect(store.backupSettings()).toEqual({ enabled: true, everyHours: 6, keep: 3, folder: join(dir, "elsewhere") });
    expect(store.actionLedger({ repos: null, instance: true, limit: 20 }).find(one => one.action === "backup settings changed")).toMatchObject({
      actor: "alex", detail: `every 24 hours, keep 7, the default folder → every 6 hours, keep 3, ${join(dir, "elsewhere")}`,
    });

    const samCookie = await signIn("sam", sam.token);
    expect((await fetch(`${base}/settings/backups`, { headers: { cookie: samCookie }, redirect: "manual" })).status).toBe(403);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("restore refuses a backup that is sound and the right version but doesn't open as a Toolroll database; the live one is untouched", async () => {
  const backup = await aBackup();
  store.close();
  // No table the store opens with: every earlier check passes, opening it doesn't.
  const broken = altered(backup, "missing-table.db", db => db.exec("DROP TABLE service_cursor"));
  for (const dryRun of [true, false]) {
    const tried = await restoreDatabase({ databaseFile: file, file: broken, dryRun, now: at(1) });
    expect(tried.ok).toBe(false);
    expect(tried.refusals).toEqual([expect.objectContaining({ reason: "schema", words: expect.stringContaining("doesn't open as a Toolroll database") })]);
    expect(tried.savedAs).toBeNull();
  }
  expect(tasksIn(file)).toEqual(["kept", "later"]);
  expect(readdirSync(dir).filter(name => name.startsWith(".restore-"))).toEqual([]);
  store = openStore(file);
});
