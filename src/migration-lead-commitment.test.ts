/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, openStoreNoMigrate, SCHEMA_VERSION, type Store } from "./store.js";
import { getCommitment, openCommitments, recordCommitment } from "./lead-commitments.js";

/** Release 0.9.15, the newest build before lead_commitment; it speaks schema v109. */
const OLDER_RELEASE = "042750ae9498305bca9b173e21320bdf5e13107b";
const REPO = join(__dirname, "..");
const T0 = new Date("2026-10-02T12:00:00.000Z");

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

const promise = (one: Store, thread: number) => recordCommitment(one, { owner: "alex", repo: null, thread, turn: null, what: "Tell you at noon tomorrow",
  condition: { kind: "time", at: "2026-10-03T12:00:00.000Z" } }, T0);

test("a store from before lead_commitment gains the table on its next upgrade, keeps its rows, and a current open changes nothing", () => {
  dir = mkdtempSync(join(tmpdir(), "so-commitment-"));
  const file = join(dir, "state.db");
  const first = openStore(file);
  const thread = first.openMateThread("alex", "ceiling", T0).thread.id;
  first.appendMateMessage({ thread, turn: null, role: "operator", text: "tell me at noon" }, T0);
  first.close();
  // The shape an older build left (lead_commitment came without a version bump): no table or indexes, an older stamp.
  // Since v114 every DDL change bumps the version, so such a file always reads older and the upgrade adds it once.
  const db = new DatabaseSync(file);
  db.exec("DROP INDEX lead_commitment_due; DROP INDEX lead_commitment_owner; DROP TABLE lead_commitment");
  db.exec("UPDATE schema_version SET version = 113");
  db.close();

  store = openStore(file);
  expect(SCHEMA_VERSION).toBe(114);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(114);
  expect(store.handle.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'lead_commitment%' ORDER BY name").all().map(row => row["name"]))
    .toEqual(["lead_commitment", "lead_commitment_due", "lead_commitment_owner"]);
  expect(store.listMateMessages(thread, 10).map(one => one.text)).toEqual(["tell me at noon"]);
  const made = promise(store, thread);
  expect(made).toMatchObject({ state: "open", channel: "chat", expiresAt: "2026-10-09T12:00:00.000Z" });
  store.close();
  // Opening again changes nothing; the strict non-migrating door reads it as current.
  store = openStore(file);
  expect(getCommitment(store, made.id)).toEqual(made);
  store.close();
  const plain = openStoreNoMigrate(file);
  expect(plain.ok).toBe(true);
  if (plain.ok) { store = plain.store; expect(openCommitments(store, "alex")).toHaveLength(1); }
});

test("the release before lead_commitment (schema v109) refuses a store this build made, without changing it, and this build reads it back", () => {
  dir = mkdtempSync(join(tmpdir(), "so-commitment-older-"));
  const file = join(dir, "state.db");
  store = openStore(file);
  const thread = store.openMateThread("alex", "ceiling", T0).thread.id;
  const made = promise(store, thread);
  store.close();
  store = undefined;

  // The older runtime is the released source itself, run through its own migrating open.
  const older = join(dir, "older");
  mkdirSync(older);
  execFileSync("sh", ["-c", `git -C "$1" archive "$2" src | tar -x -C "$3"`, "sh", REPO, OLDER_RELEASE, older]);
  symlinkSync(join(REPO, "node_modules"), join(older, "node_modules"));
  writeFileSync(join(older, "read.ts"), `import { openStore, SCHEMA_VERSION } from "./src/store.ts";
const store = openStore(process.argv[2]!);
const thread = store.openMateThread("sam", "other", new Date("2026-10-02T13:00:00.000Z")).thread.id;
store.appendMateMessage({ thread, turn: null, role: "operator", text: "written by the older build" }, new Date("2026-10-02T13:00:00.000Z"));
const count = (sql: string) => Number(store.handle.prepare(sql).get()?.["n"]);
console.log(JSON.stringify({ speaks: SCHEMA_VERSION, threads: count("SELECT COUNT(*) AS n FROM mate_thread"), promises: count("SELECT COUNT(*) AS n FROM lead_commitment") }));
store.close();
`);
  // v110 and later (the ledger's remote sources, v111's token terms, v112's request budgets, v113's MCP sign-in, v114's single shape) are newer than it speaks: it refuses to open rather than alter what it can't name.
  expect(() => execFileSync(join(REPO, "node_modules", ".bin", "tsx"), [join(older, "read.ts"), file], { cwd: older, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))
    .toThrow(/schema v114, written by a newer build/);

  store = openStore(file);
  expect(getCommitment(store, made.id)).toEqual(made);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(114);
}, 60_000);
