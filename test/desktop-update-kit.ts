/** Shared fixtures for the desktop update tests (src/desktop-update*.test.ts): an installed and a candidate app,
 * a paired state directory and a coding workspace. Each test file mocks node:child_process itself. */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION } from "../src/store.js";
import { loadOrCreateDesktopConfig, writeDesktopConfig, pairDesktopLogin } from "../src/desktop-host.js";
import { previewDesktopUpdate, prepareDesktopUpdate, durableJson, type UpdateHooks, type UpdateJournal } from "../src/desktop-update.js";
import { CodingWorkspace } from "../src/coding-workspace.js";

export function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "so-controlled-update-"))), state = join(root, "state");
  const config = loadOrCreateDesktopConfig(state, true); config.databaseInitialized = true; writeDesktopConfig(state, config);
  const store = openStore(config.databaseFile);
  pairDesktopLogin(store, join(state, "up-login.txt"), { name: "fixture", password: "retained-fixture-login" });
  store.raw().prepare("INSERT INTO task(id,title,state,created_at,updated_at) VALUES('retained','Keep my work','queued',?,?)").run(new Date().toISOString(), new Date().toISOString());
  store.close();
  const makeApp = (name: string, schemaVersion = SCHEMA_VERSION) => {
    const path = join(root, name + ".app"), resources = join(path, "Contents", "Resources");
    mkdirSync(join(resources, "runtime"), { recursive: true }); mkdirSync(join(resources, "dist"));
    writeFileSync(join(resources, "standing-orders-bundle"), "fixture");
    for (const file of ["runtime/node", "runtime/bundle-swap", "dist/desktop-host.js"]) writeFileSync(join(resources, file), name);
    writeFileSync(join(resources, "runtime.json"), JSON.stringify({ updateProtocol: 1, recoveryProtocol: 1, schemaVersion, bundleId: "com.standing-orders.desktop.development", development: true, buildId: randomUUID(), version: "0.4.3", node: "runtime/node", providerBin: dirname(process.execPath) }));
    return path;
  };
  const installed = makeApp("Installed"), candidate = makeApp("Candidate");
  const calls: string[] = []; let running = true;
  const hooks: UpdateHooks = {
    otherControllers: async () => false,
    verify: async () => {}, serviceStatus: async () => ({ state: running ? "running" : "disabled", stale: false }),
    service: async (action, app) => { calls.push(`${action}:${app.buildId}`); running = action === "start"; },
    healthy: async () => true,
    swap: async j => {
      calls.push("swap");
      const temp = join(root, "swap.tmp"), standby = join(j.workDir, "Standby.app");
      renameSync(j.old.path, temp); renameSync(standby, j.old.path); renameSync(temp, standby);
    },
    sleep: async () => {}, healthTimeoutMs: 1,
  };
  const prepare = async (overrides: UpdateHooks = {}) => {
    const selected = { ...hooks, ...overrides };
    const plan = await previewDesktopUpdate(state, installed, candidate, "com.standing-orders.test.update", selected);
    return prepareDesktopUpdate(state, installed, candidate, plan.label, plan.digest, selected);
  };
  const db = () => new DatabaseSync(config.databaseFile);
  const close = () => rmSync(root, { recursive: true, force: true });
  return { root, state, config, installed, candidate, hooks, calls, prepare, db, close, makeApp };
}

export function armFixture(j: UpdateJournal) {
  durableJson(join(j.workDir, "recovery.json"), { version: 1, id: j.id, state: "armed", attempts: 0, repairs: 0, guardianPid: null, workerPid: null, updatedAt: new Date().toISOString(), detail: "Ready" });
  return () => JSON.parse(readFileSync(join(j.workDir, "recovery.json"), "utf8"));
}

export function codingFixture(f: ReturnType<typeof fixture>, status = 'ready') {
  const file = `${f.config.databaseFile}.coding.sqlite`;
  const workspace = new CodingWorkspace({ database: file, worktreeRoot: join(f.root, 'coding-worktrees') });
  const db = new DatabaseSync(file);
  const session = { id: 'coding-one', owner: 'fixture', generation: 1, repo: f.root, title: 'Retained coding work', nativeThreadId: 'native-one', status, turnId: status === 'working' ? 'turn-one' : null };
  db.prepare('INSERT INTO coding_session(id,owner,generation,repo,document) VALUES(?,?,?,?,?)').run(session.id, session.owner, session.generation, session.repo, JSON.stringify(session));
  db.prepare('INSERT INTO coding_item(session,id,payload) VALUES(?,?,?)').run(session.id, 'item-one', JSON.stringify({ text: 'A committed WAL transcript item' }));
  db.prepare('INSERT INTO coding_custody(singleton,payload) VALUES(1,?)').run(JSON.stringify({ pid: null, group: false, descendants: [], observationUnknown: false }));
  return { workspace, db, file, session, close: async () => { db.close(); await workspace.close(); } };
}
