import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, statSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { openStore } from './store.js';
import { CodingWorkspace } from './coding-workspace.js';
import { installUpdateGate, freezeUpdateGate, removeUpdateGate, updateGateOwned } from './desktop-update-gate.js';
import { loadCodingDeploymentRuntime, observeCodingDeployment, backupCodingDeployment, verifyCodingDeploymentBackup, assertCodingDeploymentStopped, releaseStaleCodingDeployment } from '../scripts/deploy-coding.mjs';
import { fakePid } from '../test/fake-pid.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'so-browser-coding-update-'));
  const database = join(root, 'orders.db'), stage = join(root, 'stage');
  mkdirSync(stage);
  const store = openStore(database);
  const record: { id: string; codingBackupPath?: string; codingBackupHash?: string; codingCatalogExpected?: boolean } = { id: randomUUID() };
  return { root, database, stage, store, record, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('browser deployment permits a legacy runtime only while its coding catalog is absent', async () => {
  const f = fixture();
  try {
    expect(await loadCodingDeploymentRuntime(f.root)).toBeNull();
    await backupCodingDeployment(null, f.database, f.stage, f.record);
    verifyCodingDeploymentBackup(null, f.database, f.stage, f.record);
    assertCodingDeploymentStopped(null, f.database, f.store.raw());
    expect(existsSync(`${f.database}.coding.sqlite`)).toBe(false);
    expect(f.record.codingBackupPath).toBeUndefined();
    expect(f.record.codingCatalogExpected).toBe(false);
    writeFileSync(`${f.database}.coding.sqlite`, 'a catalog from a different runtime');
    await expect(backupCodingDeployment(null, f.database, f.stage, f.record)).rejects.toThrow('installed runtime cannot safely');
    expect(() => assertCodingDeploymentStopped(null, f.database, f.store.raw())).toThrow('installed runtime cannot safely');
  } finally { f.close(); }
});

test('browser deployment uses installed SQLite backup for WAL history and refuses swap until native shutdown is recorded', async () => {
  const f = fixture();
  const coding = await loadCodingDeploymentRuntime(resolve('dist'));
  const file = `${f.database}.coding.sqlite`;
  const workspace = new CodingWorkspace({ database: file, worktreeRoot: join(f.root, 'worktrees') });
  const db = new DatabaseSync(file);
  try {
    const session = { id: 'retained-session', owner: 'alex', generation: 1, repo: f.root, title: 'Retained session', provider: 'codex', model: null, branch: 'toolroll/code-retained-session', base: 'a'.repeat(40), worktree: join(f.root, 'worktrees', 'retained-session'), nativeThreadId: 'native-saved', turnId: null, status: 'ready', error: null, createdAt: '2026-10-04T18:00:00.000Z', updatedAt: '2026-10-04T18:00:00.000Z' };
    db.prepare('INSERT INTO coding_session(id,owner,generation,repo,document) VALUES(?,?,?,?,?)').run(session.id, session.owner, session.generation, session.repo, JSON.stringify(session));
    db.prepare('INSERT INTO coding_item(session,id,payload) VALUES(?,?,?)').run(session.id, 'reply', JSON.stringify({ text: 'Keep this committed WAL reply.' }));
    const agentPid = fakePid(1), toolPid = fakePid(2);
    db.prepare('INSERT INTO coding_custody(singleton,payload) VALUES(1,?)').run(JSON.stringify({ pid: agentPid, group: true, descendants: [{ pid: toolPid, group: false }], observationUnknown: false }));
    installUpdateGate(f.store.raw(), f.record.id);
    expect(() => assertCodingDeploymentStopped(coding, f.database, f.store.raw())).toThrow('not verified agent and tool shutdown');
    await backupCodingDeployment(coding, f.database, f.stage, f.record);
    expect(f.record.codingBackupHash).toMatch(/^[a-f0-9]{64}$/);
    verifyCodingDeploymentBackup(coding, f.database, f.stage, f.record);
    const copied = new DatabaseSync(f.record.codingBackupPath!, { readOnly: true });
    try {
      expect(copied.prepare('SELECT payload FROM coding_item').get()?.payload).toContain('committed WAL reply');
      expect(copied.prepare('SELECT payload FROM coding_custody').get()?.payload).toContain(String(toolPid));
      expect(copied.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name GLOB 'so_coding_update_*'").get()?.n).toBe(0);
    } finally { copied.close(); }
    expect(statSync(f.record.codingBackupPath!).mode & 0o777).toBe(0o600);
    const originalHash = f.record.codingBackupHash;
    await workspace.close();
    assertCodingDeploymentStopped(coding, f.database, f.store.raw(), f.record);
    await backupCodingDeployment(coding, f.database, f.stage, f.record);
    expect(f.record.codingBackupHash).toBe(originalHash);
    writeFileSync(f.record.codingBackupPath!, 'changed backup');
    await expect(backupCodingDeployment(coding, f.database, f.stage, f.record)).rejects.toThrow('not overwritten');
    expect(readFileSync(f.record.codingBackupPath!, 'utf8')).toBe('changed backup');
  } finally { db.close(); await workspace.close(); f.close(); }
});

test('browser deployment refuses an unbacked or disappeared catalog and preserves an existing backup destination', async () => {
  const f = fixture();
  const coding = await loadCodingDeploymentRuntime(resolve('dist'));
  const file = `${f.database}.coding.sqlite`;
  const workspace = new CodingWorkspace({ database: file, worktreeRoot: join(f.root, 'worktrees') });
  try {
    expect(() => verifyCodingDeploymentBackup(coding, f.database, f.stage, f.record)).toThrow('no verified deployment backup');
    const target = join(f.stage, 'coding.backup.sqlite');
    writeFileSync(target, 'retained unfinished attempt');
    await expect(backupCodingDeployment(coding, f.database, f.stage, f.record)).rejects.toThrow('already exists');
    expect(readFileSync(target, 'utf8')).toBe('retained unfinished attempt');
    await workspace.close();
    rmSync(file);
    f.record.codingBackupPath = target;
    f.record.codingBackupHash = 'a'.repeat(64);
    expect(() => verifyCodingDeploymentBackup(coding, f.database, f.stage, f.record)).toThrow('disappeared');
    expect(() => assertCodingDeploymentStopped(coding, f.database, f.store.raw(), f.record)).toThrow('disappeared');
  } finally { await workspace.close(); f.close(); }
});

test.each(['backup', 'verify', 'stop'])('browser %s refuses a catalog lost after its presence was saved but before backup', async action => {
  const f = fixture(), coding = await loadCodingDeploymentRuntime(resolve('dist'));
  const file = `${f.database}.coding.sqlite`;
  const workspace = new CodingWorkspace({ database: file, worktreeRoot: join(f.root, 'worktrees') });
  try {
    expect(observeCodingDeployment(coding, f.database, f.record)).toBe(file);
    expect(f.record.codingCatalogExpected).toBe(true);
    const saved = JSON.parse(JSON.stringify(f.record));
    await workspace.close(); rmSync(file);
    if (action === 'backup') await expect(backupCodingDeployment(coding, f.database, f.stage, saved)).rejects.toThrow('disappeared');
    if (action === 'verify') expect(() => verifyCodingDeploymentBackup(coding, f.database, f.stage, saved)).toThrow('disappeared');
    if (action === 'stop') expect(() => assertCodingDeploymentStopped(coding, f.database, f.store.raw(), saved)).toThrow('disappeared');
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(f.stage, 'coding.backup.sqlite'))).toBe(false);
    expect(saved.codingCatalogExpected).toBe(true);
  } finally { await workspace.close(); f.close(); }
});

test('browser presence is retained across a failed backup and rejects malformed or forgotten custody', async () => {
  const f = fixture();
  const file = `${f.database}.coding.sqlite`;
  writeFileSync(file, 'observed catalog');
  const runtime = { backupCodingCatalog: async () => { rmSync(file); } };
  try {
    await expect(backupCodingDeployment(runtime, f.database, f.stage, f.record)).rejects.toThrow('disappeared');
    expect(f.record.codingCatalogExpected).toBe(true);
    expect(f.record.codingBackupPath).toBeUndefined();
    expect(() => observeCodingDeployment(runtime, f.database, { codingCatalogExpected: 'false' })).toThrow('presence is invalid');
    expect(() => observeCodingDeployment(runtime, f.database, { codingBackupHash: 'a'.repeat(64) })).toThrow('disappeared');
  } finally { f.close(); }
});

test('a first browser catalog appearing after prepare or startup gets a verified late backup', async () => {
  const f = fixture(), coding = await loadCodingDeploymentRuntime(resolve('dist'));
  try {
    await backupCodingDeployment(null, f.database, f.stage, f.record);
    const workspace = new CodingWorkspace({ database: `${f.database}.coding.sqlite`, worktreeRoot: join(f.root, 'worktrees') });
    await workspace.close();
    expect(() => verifyCodingDeploymentBackup(coding, f.database, f.stage, f.record)).toThrow('no verified deployment backup');
    await backupCodingDeployment(coding, f.database, f.stage, f.record);
    verifyCodingDeploymentBackup(coding, f.database, f.stage, f.record);
    expect(f.record.codingCatalogExpected).toBe(true);
    expect(f.record.codingBackupHash).toMatch(/^[a-f0-9]{64}$/);
    assertCodingDeploymentStopped(coding, f.database, f.store.raw(), f.record);
  } finally { f.close(); }
});

test.each(['missing', 'changed', 'linked'])('browser final backup checks reject %s retained bytes without overwriting', async damage => {
  const f = fixture(), coding = await loadCodingDeploymentRuntime(resolve('dist'));
  const workspace = new CodingWorkspace({ database: `${f.database}.coding.sqlite`, worktreeRoot: join(f.root, 'worktrees') });
  await workspace.close();
  try {
    await backupCodingDeployment(coding, f.database, f.stage, f.record);
    const target = f.record.codingBackupPath!;
    if (damage === 'changed') writeFileSync(target, 'changed retained bytes');
    else { renameSync(target, target + '.preserved'); if (damage === 'linked') symlinkSync(target + '.preserved', target); }
    expect(() => verifyCodingDeploymentBackup(coding, f.database, f.stage, f.record)).toThrow('missing, linked or changed');
    await expect(backupCodingDeployment(coding, f.database, f.stage, f.record)).rejects.toThrow('not overwritten');
    if (damage === 'changed') expect(readFileSync(target, 'utf8')).toBe('changed retained bytes');
  } finally { f.close(); }
});

test('a broken installed coding module is not silently treated as a legacy runtime', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'coding-update.js'), "import './missing-installed-dependency.js';\n");
    await expect(loadCodingDeploymentRuntime(f.root)).rejects.toThrow();
  } finally { f.close(); }
});

test('browser phase wiring verifies the coding backup before stop and custody before swap or restore', () => {
  // The deployment CLI has real launchd effects; verify its orchestration here
  // without executing it. Catalog behavior above uses real SQLite databases.
  const source = readFileSync(resolve('scripts/deploy-browser.mjs'), 'utf8');
  const prepare = source.slice(source.indexOf('async function prepare('), source.indexOf('async function rehearse('));
  const frozen = prepare.indexOf('save(r, "frozen")');
  expect(prepare.lastIndexOf('observeCodingDeployment(', frozen)).toBeGreaterThan(prepare.indexOf('freezeUpdateGate('));
  expect(frozen).toBeLessThan(prepare.indexOf('await snapshotBackup(original'));
  expect(prepare.indexOf('await ensureCodingBackup(')).toBeGreaterThan(prepare.indexOf('await snapshotBackup(original'));
  expect(prepare).not.toContain('BEGIN IMMEDIATE');
  expect(prepare).toContain('view => verifyPreparedDatabase(view, r)');
  expect(prepare.indexOf('await ensureCodingBackup(')).toBeLessThan(prepare.lastIndexOf('verifyPreparedDatabase(db, r)'));
  expect(prepare.lastIndexOf('verifyPreparedDatabase(db, r)')).toBeLessThan(prepare.indexOf('save(r, "backup-verified")'));
  const swap = source.slice(source.indexOf('async function swap('), source.indexOf('async function finish('));
  expect(swap.indexOf('await ensureCodingBackup(')).toBeLessThan(swap.indexOf('save(r, "stopping")'));
  expect(swap.indexOf('r.stoppingService = service(priorDist)')).toBeLessThan(swap.indexOf('save(r, "stopping")'));
  expect(swap).toContain('r.oldService.supervisor, ...r.oldService.children, r.stoppingService.supervisor, ...r.stoppingService.children');
  expect(swap.lastIndexOf('await verifyServiceStopped(oldPids)')).toBeGreaterThan(swap.indexOf('(await load(nextDist, "store.js"))'));
  expect(swap.lastIndexOf('await verifyServiceStopped(oldPids)')).toBeLessThan(swap.lastIndexOf('assertCodingDeploymentStopped(oldRt.coding'));
  expect(swap.indexOf('await verifyServiceStopped(oldPids)')).toBeLessThan(swap.indexOf('assertCodingDeploymentStopped(oldRt.coding'));
  expect(swap.indexOf('assertCodingDeploymentStopped(oldRt.coding')).toBeLessThan(swap.indexOf('save(r, "migrating")'));
  expect(swap.lastIndexOf('assertCodingDeploymentStopped(oldRt.coding')).toBeGreaterThan(swap.indexOf('(await load(nextDist, "store.js"))'));
  expect(swap.lastIndexOf('assertCodingDeploymentStopped(oldRt.coding')).toBeLessThan(swap.indexOf('writeFileSync(plist, nextPlist)'));
  const rollback = swap.slice(swap.indexOf('if (live === null)'));
  expect(rollback.indexOf('await verifyServiceStopped(failedPids)')).toBeLessThan(rollback.indexOf('assertCodingDeploymentStopped(coding'));
  expect(rollback.lastIndexOf('await verifyServiceStopped(failedPids)')).toBeGreaterThan(rollback.indexOf('await loadCodingDeploymentRuntime(nextDist)'));
  expect(rollback.lastIndexOf('await verifyServiceStopped(failedPids)')).toBeLessThan(rollback.indexOf('assertCodingDeploymentStopped(coding'));
  // Custody is proved before the failed start is handed to the exit recovery, which puts the backup and the previous service back.
  expect(rollback.indexOf('assertCodingDeploymentStopped(coding')).toBeLessThan(rollback.indexOf('save(r, "start-failed")'));
  expect(rollback).not.toContain('restorePriorService(');
  const restart = source.slice(source.indexOf('function restorePriorService('), source.indexOf('/** A clean checkout of the commit'));
  expect(restart.indexOf('version !== r.schema')).toBeLessThan(restart.indexOf('"bootstrap"'));
  expect(restart.indexOf('"bootstrap"')).toBeLessThan(restart.indexOf('waitUntilHealthy(answers)'));
  expect(restart).toContain('/healthz');
  expect(source).toContain('process.on("exit", code => { if (code !== 0) recoverJournal(); });\nexitOnSignals();');
  const finish = source.slice(source.indexOf('async function finish('));
  expect(finish.indexOf('await ensureCodingBackup(coding')).toBeLessThan(finish.indexOf('await fetch('));
  expect(finish.lastIndexOf('await ensureCodingBackup(coding')).toBeGreaterThan(finish.indexOf('await sleep('));
  expect(finish.lastIndexOf('verifyCodingBackup(coding')).toBeGreaterThan(finish.lastIndexOf('await ensureCodingBackup(coding'));
  expect(finish.lastIndexOf('verifyCodingBackup(coding')).toBeLessThan(finish.indexOf('removeUpdateGate('));
  const ensure = source.slice(source.indexOf('async function ensureCodingBackup('), source.indexOf('async function prepare('));
  expect(ensure.indexOf('save(r, r.phase)')).toBeLessThan(ensure.indexOf('await backupCodingDeployment('));
  const replace = swap.slice(swap.indexOf('// Migration loads asynchronously'), swap.indexOf('writeFileSync(plist, nextPlist)'));
  expect(replace.indexOf('await ensureCodingBackup(')).toBeLessThan(replace.indexOf('await verifyServiceStopped('));
  expect(replace.indexOf('verifyCodingBackup(')).toBeGreaterThan(replace.lastIndexOf('await '));
  const restore = rollback.slice(0, rollback.indexOf('save(r, "start-failed")'));
  expect(restore.indexOf('await ensureCodingBackup(')).toBeLessThan(restore.lastIndexOf('await verifyServiceStopped('));
  expect(restore.indexOf('verifyCodingBackup(')).toBeGreaterThan(restore.lastIndexOf('await '));
  expect(swap.lastIndexOf('await ensureCodingBackup(await loadCodingDeploymentRuntime(nextDist), r)')).toBeGreaterThan(swap.indexOf('save(r, "started")'));
  // A stale owner is released only after every old pid is proved gone, by the staged candidate, before the stop is checked.
  const release = swap.indexOf('releaseStaleCodingDeployment(candidateCoding');
  expect(release).toBeGreaterThan(swap.indexOf('save(r, "stopped")'));
  expect(swap.indexOf('await verifyServiceStopped(oldPids)')).toBeLessThan(release);
  expect(swap.indexOf('loadCodingDeploymentRuntime(nextDist)')).toBeLessThan(release);
  expect(release).toBeLessThan(swap.indexOf('assertCodingDeploymentStopped(oldRt.coding'));
  // Any failure after that restores the old service and lifts this deployment's own pause on exit.
  const exit = source.slice(source.indexOf('function recoverJournal('), source.indexOf('function restorePriorService('));
  expect(exit).toContain('recoverFailedDeployment(r.phase, {');
  expect(exit).toContain('restoreBackup: () => restoreDeploymentBackup(r)');
  expect(exit).toContain('restoreService: () => restorePriorService(r)');
  expect(exit).toContain('--phase recover');
  expect(exit).toContain('oldRt.gate.removeUpdateGate(db, r.id)');
});

function browserDatabaseHelpers(snapshot: (db: DatabaseSync) => unknown = () => [], copy: typeof backup = backup) {
  const source = readFileSync(resolve('scripts/deploy-browser.mjs'), 'utf8');
  // Exercise the CLI's exact helpers without executing its launchd entry point.
  const functions = source.slice(source.indexOf('function openDeploymentDatabase('), source.indexOf('const args = process.argv.slice(2);'));
  return new Function('DatabaseSync', 'snapshot', 'backup', functions + '\nreturn { openDeploymentDatabase, snapshotBackup };')(DatabaseSync, snapshot, copy) as {
    openDeploymentDatabase(file: string, options?: { readOnly?: boolean }, waitMs?: number): DatabaseSync;
    snapshotBackup(db: DatabaseSync, target: string, validate?: (db: DatabaseSync) => void): Promise<unknown>;
  };
}

test('browser deployment waits through a competing writer before installing its admission gate', async () => {
  const f = fixture(), helpers = browserDatabaseHelpers();
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE');
    process.stdout.write('locked'); setTimeout(()=>db.close(),1500);`, f.database], { stdio: ['ignore', 'pipe', 'pipe'] });
  const ended = new Promise<void>(resolve => child.once('close', () => resolve()));
  let db: DatabaseSync | undefined;
  try {
    await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); child.once('exit', code => { if (code !== 0) reject(Error('lock fixture failed')); }); });
    db = helpers.openDeploymentDatabase(f.database);
    expect(db.prepare('PRAGMA busy_timeout').get()?.timeout).toBe(5000);
    installUpdateGate(db, f.record.id);
    expect(updateGateOwned(db, f.record.id)).toBe(true);
    // A resumed preparing phase reuses its gate identity, rather than replacing it.
    installUpdateGate(db, f.record.id);
    expect(() => installUpdateGate(db, randomUUID())).toThrow('Another or unrecognized update');
    const source = readFileSync(resolve('scripts/deploy-browser.mjs'), 'utf8');
    expect(source.match(/new DatabaseSync\(/g)).toHaveLength(1);
    expect(source).toContain('openDeploymentDatabase(database, {}, 10000)');
    expect(source).toContain('existsSync(journalFile) ? loadPhase("preparing") : null');
    expect(source).toContain('const r = resumed ??');
  } finally { child.kill(); await ended; db?.close(); f.close(); }
}, 8000);

test('browser backup preserves its read snapshot across concurrent WAL writes and releases it afterward', async () => {
  const f = fixture(), target = join(f.stage, 'orders.backup.db');
  f.store.raw().exec('CREATE TABLE snapshot_probe(value INTEGER); INSERT INTO snapshot_probe VALUES(1)');
  installUpdateGate(f.store.raw(), f.record.id);
  expect(freezeUpdateGate(f.store.raw(), f.record.id)).toBe(true);
  f.store.raw().prepare('INSERT INTO watch_lease VALUES(?,?,?,?,?,?,?)').run('worker', '/repo', 'incarnation', 1, 'before', 'later', 'before');
  const helpers = browserDatabaseHelpers(db => db.prepare('SELECT value FROM snapshot_probe').all(), async (db, path, options) => {
    expect(options?.rate).toBe(100000);
    // A real concurrent worker connection may still renew its watch while
    // the frozen deployment copies a consistent older view of the database.
    f.store.raw().exec("INSERT INTO snapshot_probe VALUES(2); UPDATE watch_lease SET heartbeat_at='after'");
    expect(updateGateOwned(f.store.raw(), f.record.id)).toBe(true);
    return backup(db, path, options);
  });
  const original = helpers.openDeploymentDatabase(f.database, { readOnly: true });
  try {
    let validations = 0;
    expect(await helpers.snapshotBackup(original, target, view => {
      validations++;
      expect(updateGateOwned(view, f.record.id)).toBe(true);
      expect(view.prepare('SELECT heartbeat_at FROM watch_lease').get()?.heartbeat_at).toBe('before');
    })).toEqual([{ value: 1 }]);
    expect(validations).toBe(1);
    const copy = helpers.openDeploymentDatabase(target, { readOnly: true });
    try {
      expect(copy.prepare('SELECT value FROM snapshot_probe').all()).toEqual([{ value: 1 }]);
      expect(copy.prepare('SELECT heartbeat_at FROM watch_lease').get()?.heartbeat_at).toBe('before');
      expect(updateGateOwned(copy, f.record.id)).toBe(true);
    } finally { copy.close(); }
    expect(original.prepare('SELECT value FROM snapshot_probe').all()).toEqual([{ value: 1 }, { value: 2 }]);
    expect(original.prepare('SELECT heartbeat_at FROM watch_lease').get()?.heartbeat_at).toBe('after');
  } finally { original.close(); f.close(); }
});


function preparedDatabaseGuard(facts: (db: DatabaseSync) => unknown, quiet: (db: DatabaseSync) => void) {
  const source = readFileSync(resolve('scripts/deploy-browser.mjs'), 'utf8');
  const body = source.slice(source.indexOf('function verifyPreparedDatabase('), source.indexOf('async function prepare('));
  return new Function('oldRt', 'facts', 'quiet', 'requireTrue', body + '\nreturn verifyPreparedDatabase;')(
    { gate: { updateGateOwned } }, facts, quiet, (okay: unknown, message: string) => { if (!okay) throw Error(message); },
  ) as (db: DatabaseSync, record: Record<string, unknown>) => void;
}

test.each(['gate', 'schema', 'completion', 'check', 'scope', 'active-work'])('browser backup refuses a changed %s after copying without reserving the writer', async change => {
  const f = fixture(), target = join(f.stage, 'orders.backup.db');
  const current = { completion: { digest: 'complete' }, gateDigest: 'check', taskId: 'task', repo: '/repo', scopeDigest: 'scope' };
  const record = { ...f.record, schema: Number(f.store.raw().prepare('SELECT version FROM schema_version').get()?.version),
    completion: { ...current.completion }, gateDigest: current.gateDigest, task: current.taskId, repo: current.repo, scopeDigest: current.scopeDigest };
  let active = false;
  const guard = preparedDatabaseGuard(() => current, () => { if (active) throw Error('Current work must finish first'); });
  installUpdateGate(f.store.raw(), record.id); expect(freezeUpdateGate(f.store.raw(), record.id)).toBe(true);
  const helpers = browserDatabaseHelpers(() => [], async (db, path, options) => {
    const result = await backup(db, path, options);
    if (change === 'gate') removeUpdateGate(f.store.raw(), record.id);
    if (change === 'schema') f.store.raw().exec('UPDATE schema_version SET version=version+1');
    if (change === 'completion') current.completion.digest = 'changed';
    if (change === 'check') current.gateDigest = 'changed';
    if (change === 'scope') current.scopeDigest = 'changed';
    if (change === 'active-work') active = true;
    return result;
  });
  const original = helpers.openDeploymentDatabase(f.database, { readOnly: true });
  try {
    await helpers.snapshotBackup(original, target, view => guard(view, record));
    expect(() => guard(f.store.raw(), record)).toThrow(/preparation schema|completed result|Current work/);
  } finally { original.close(); f.close(); }
});

test('refused snapshot authority releases the read transaction without creating a backup', async () => {
  const f = fixture(), target = join(f.stage, 'orders.backup.db'), helpers = browserDatabaseHelpers();
  const original = helpers.openDeploymentDatabase(f.database, { readOnly: true });
  try {
    await expect(helpers.snapshotBackup(original, target, () => { throw Error('stale candidate'); })).rejects.toThrow('stale candidate');
    expect(existsSync(target)).toBe(false);
    original.exec('BEGIN'); original.exec('ROLLBACK');
    f.store.raw().exec('CREATE TABLE heartbeat_probe(value INTEGER)');
  } finally { original.close(); f.close(); }
});

test('a deploy over a runtime killed before its close releases the stale owner once its processes are proved gone, and ledgers it', async () => {
  // Oct 2: 0.9.11 was booted out, every old pid was gone, and the catalog still named its `cli.js up` child.
  const f = fixture();
  const sibling = fakePid(2), service = fakePid(3), agent = fakePid(4), stranger = fakePid(5);
  const candidate = await loadCodingDeploymentRuntime(resolve('dist'));
  const file = `${f.database}.coding.sqlite`;
  const workspace = new CodingWorkspace({ database: file, worktreeRoot: join(f.root, 'worktrees') });
  await workspace.close();
  const db = new DatabaseSync(file);
  try {
    db.prepare('UPDATE coding_owner SET token=?,pid=?,native_pid=?,clean=0').run(randomUUID(), service, agent);
    db.close();
    const orders = f.store.raw();
    expect(() => assertCodingDeploymentStopped(candidate, f.database, orders, f.record)).toThrow('not verified agent and tool shutdown');
    // Not a process this deploy stopped: never released.
    expect(() => releaseStaleCodingDeployment(candidate, f.database, orders, [stranger], f.record)).toThrow('not one this update stopped');
    expect(releaseStaleCodingDeployment(candidate, f.database, orders, [sibling, service], f.record)).toEqual({ pid: service, nativePid: agent });
    expect(f.record).toMatchObject({ codingOwnerReleased: { pid: service, nativePid: agent }, codingOwnerReleasedAt: expect.any(String) });
    // The release time is kept so a restored ledger can date it the same.
    const releasedAt = (f.record as { codingOwnerReleasedAt?: string }).codingOwnerReleasedAt;
    expect(orders.prepare("SELECT at FROM action_ledger WHERE action='coding owner released'").get()).toEqual({ at: releasedAt });
    assertCodingDeploymentStopped(candidate, f.database, orders, f.record);
    expect(orders.prepare("SELECT actor,action,outcome FROM action_ledger WHERE action='coding owner released'").all()).toEqual([{ actor: 'deploy', action: 'coding owner released', outcome: 'released' }]);
    // Already released by an ordinary stop: nothing to do, nothing ledgered twice.
    expect(releaseStaleCodingDeployment(candidate, f.database, orders, [service], f.record)).toBeNull();
    // A candidate without the release keeps the ordinary refusal.
    expect(releaseStaleCodingDeployment({}, f.database, orders, [service], f.record)).toBeNull();
  } finally { if (db.isOpen) db.close(); f.close(); }
});

test('a stale owner whose agent or session still lives is never released by a deploy', async () => {
  const f = fixture();
  const service = fakePid(3);
  const candidate = await loadCodingDeploymentRuntime(resolve('dist'));
  const file = `${f.database}.coding.sqlite`;
  const workspace = new CodingWorkspace({ database: file, worktreeRoot: join(f.root, 'worktrees') });
  await workspace.close();
  // The agent is detached into its own process group: a killed service can leave it running.
  const agent = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  try {
    const db = new DatabaseSync(file);
    try {
      db.prepare('UPDATE coding_owner SET token=?,pid=?,native_pid=?,clean=0').run(randomUUID(), service, agent.pid!);
      expect(() => releaseStaleCodingDeployment(candidate, f.database, f.store.raw(), [service], f.record)).toThrow(/agent process \d+ is still running/);
      db.prepare('UPDATE coding_owner SET native_pid=NULL').run();
      const session = { id: 'live', owner: 'alex', generation: 1, repo: f.root, status: 'working', turnId: 'turn-1' };
      db.prepare('INSERT INTO coding_session(id,owner,generation,repo,document) VALUES(?,?,?,?,?)').run(session.id, session.owner, session.generation, session.repo, JSON.stringify(session));
      expect(() => releaseStaleCodingDeployment(candidate, f.database, f.store.raw(), [service], f.record)).toThrow('1 coding session(s)');
      expect(db.prepare('SELECT pid FROM coding_owner').get()?.pid).toBe(service);
    } finally { db.close(); }
  } finally { agent.kill(); f.close(); }
});
