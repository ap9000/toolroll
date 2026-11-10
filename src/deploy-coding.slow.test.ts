import { test, expect, vi } from 'vitest';
import { copyFileSync, mkdtempSync, mkdirSync, existsSync, readFileSync, readdirSync, realpathSync, writeFileSync, rmSync, statSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { spawn, spawnSync as realSpawnSync, type ChildProcess } from 'node:child_process';
import { openStore } from './store.js';
import { CodingWorkspace } from './coding-workspace.js';
import * as gate from './desktop-update-gate.js';
import { installUpdateGate, freezeUpdateGate, removeUpdateGate, updateGateOwned } from './desktop-update-gate.js';
import { durableJson } from './desktop-update.js';
import { loadCodingDeploymentRuntime, observeCodingDeployment, backupCodingDeployment, verifyCodingDeploymentBackup, assertCodingDeploymentStopped, releaseStaleCodingDeployment } from '../scripts/deploy-coding.mjs';
import { browserDeployment, openDeploymentDatabase, snapshotBackup } from '../scripts/deploy-phases.mjs';
import { commandKind, listProcesses, serviceStopper } from '../scripts/deploy-stop.mjs';
import { acquireDeploymentLock } from './deploy-lock.js';
import { deploymentChild } from '../test/deploy-process.js';
import { fakePid } from '../test/fake-pid.js';
import { deployment, killedAtStarting, migratedRows, quietly, said, tamper } from '../test/deploy-phases-fixture.js';

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
  const workspace = new CodingWorkspace({ database: file, worktreeRoot: join(f.root, 'worktrees'), permissions: () => ({ sandbox: 'workspace-write' }) });
  const db = new DatabaseSync(file);
  try {
    const session = { id: 'retained-session', owner: 'alex', generation: 1, repo: f.root, status: 'ready', nativeThreadId: 'native-saved', turnId: null };
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
  const workspace = new CodingWorkspace({ database: file, worktreeRoot: join(f.root, 'worktrees'), permissions: () => ({ sandbox: 'workspace-write' }) });
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
  const workspace = new CodingWorkspace({ database: file, worktreeRoot: join(f.root, 'worktrees'), permissions: () => ({ sandbox: 'workspace-write' }) });
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
    const workspace = new CodingWorkspace({ database: `${f.database}.coding.sqlite`, worktreeRoot: join(f.root, 'worktrees'), permissions: () => ({ sandbox: 'workspace-write' }) });
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
  const workspace = new CodingWorkspace({ database: `${f.database}.coding.sqlite`, worktreeRoot: join(f.root, 'worktrees'), permissions: () => ({ sandbox: 'workspace-write' }) });
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

test('prepare pauses and freezes admission, observes custody, then backs up and re-verifies before backup-verified', async () => {
  const d = await deployment({ codingCatalog: false });
  try {
    const backupFile = join(d.stage, 'orders.backup.db');
    // A catalog that first appears as admission freezes is in the frozen record and backed up after the database copy.
    d.hooks.freeze = d.appearCatalog;
    d.hooks.facts = () => {
      d.log.push(`facts ${existsSync(backupFile) ? 'after' : 'before'} backup${existsSync(d.codingBackup) ? ' and coding backup' : ''}`);
      // The copy holds a read view, never the writer: a worker heartbeat is not refused while it runs.
      if (!existsSync(backupFile)) { const worker = d.orders(); try { worker.exec("INSERT OR REPLACE INTO watch_lease VALUES('worker','/repo','owner',1,'now','later','now')"); } finally { worker.close(); } }
    };
    await d.phases.prepare({ packageSha256: 'staged' });
    expect(d.log).toEqual(['facts before backup', 'preparing', 'admission-paused', 'frozen', 'facts before backup', 'installed backs up coding', 'facts after backup and coding backup', 'backup-verified']);
    expect(d.journals['admission-paused'].codingCatalogExpected).toBe(false);
    expect(d.journals.frozen.codingCatalogExpected).toBe(true);
    expect(d.journal()).toMatchObject({ phase: 'backup-verified', backupSha256: expect.stringMatching(/^[a-f0-9]{64}$/), codingBackupHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(d.gateOwned()).toBe(true);
  } finally { d.close(); }
});

test('prepare refuses a result changed while the coding backup was copied, and resumes a preparing journal under its own pause', async () => {
  const d = await deployment();
  try {
    d.hooks.codingBackup = () => { d.current.completion.digest = 'changed'; };
    await expect(d.phases.prepare({ packageSha256: 'staged' })).rejects.toThrow('changed during backup');
    expect(d.journal().phase).toBe('frozen');
  } finally { d.close(); }
  // Admission could not be paused: the preparing journal is kept and its identity reused, never a second gate.
  const resumed = await deployment();
  try {
    let refusals = 1;
    resumed.hooks.install = () => { if (refusals-- > 0) throw Error('database is locked'); };
    const staged = { packageSha256: createHash('sha256').update('packed candidate').digest('hex') };
    await expect(resumed.phases.prepare(staged)).rejects.toThrow('database is locked');
    const first = resumed.journal();
    expect(first.phase).toBe('preparing');
    await resumed.phases.prepare(staged);
    expect(resumed.journal()).toMatchObject({ id: first.id, phase: 'backup-verified' });
    expect(resumed.gateOwned()).toBe(true);
  } finally { resumed.close(); }
});

test('a deploy that fails between journaling preparing and the next marker lifts the pause it installed', async () => {
  const d = await deployment();
  try {
    // The journal names the pause's owner before the pause exists.
    let atInstall: Record<string, any> | undefined;
    d.hooks.install = () => { atInstall = d.journal(); };
    d.hooks.installed = () => { throw Error('killed after the pause was installed'); };
    await expect(d.phases.prepare({ packageSha256: 'staged' })).rejects.toThrow('killed after the pause');
    expect(atInstall).toMatchObject({ phase: 'preparing', id: expect.any(String), schema: expect.any(Number), priorRuntime: expect.any(String), nextRuntime: d.nextDist, completion: { digest: 'complete' }, gateDigest: 'check' });
    expect([d.journal().phase, d.journal().id, d.gateOwned()]).toEqual(['preparing', atInstall!.id, true]);
    // Exit recovery lifts exactly that pause, journals it, and leaves the old service as it was.
    expect(quietly(() => d.phases.recoverJournal())).toBe(true);
    expect([d.journal().phase, d.gateOwned()]).toEqual(['released', false]);
    expect(d.log.filter(one => /bootout|bootstrap/.test(one))).toEqual([]);
    expect([readFileSync(d.plist, 'utf8'), d.services.running]).toEqual([d.livePlist, 'old']);
  } finally { d.close(); }
});

test('a deploy that fails while preparing never lifts a pause another update holds', async () => {
  const d = await deployment();
  try {
    const other = randomUUID();
    const db = d.orders();
    try { gate.installUpdateGate(db, other); } finally { db.close(); }
    await expect(d.phases.prepare({ packageSha256: 'staged' })).rejects.toThrow('Another or unrecognized update');
    expect(d.journal().phase).toBe('preparing');
    // Nothing of its own to undo: the other update's pause stays and the journal stays resumable.
    expect(quietly(() => d.phases.recoverJournal())).toBe(true);
    expect(d.journal().phase).toBe('preparing');
    const after = d.orders();
    try { expect(gate.updateGateOwned(after, other)).toBe(true); } finally { after.close(); }
  } finally { d.close(); }
});

test('every refusal before the swap lifts the pause it holds and leaves the old service running', async () => {
  for (const phase of ['admission-paused', 'frozen'] as const) {
    const d = await deployment();
    try {
      // Fail right after the named phase is journaled.
      const fail = () => { throw Error(`refused at ${phase}`); };
      if (phase === 'admission-paused') d.hooks.freeze = fail; else d.hooks.facts = () => { if (existsSync(join(d.stage, 'deployment.json')) && d.journal().phase === 'frozen') fail(); };
      await expect(d.phases.prepare({ packageSha256: 'staged' })).rejects.toThrow(`refused at ${phase}`);
      expect([d.journal().phase, d.gateOwned()]).toEqual([phase, true]);
      expect(quietly(() => d.phases.recoverJournal())).toBe(true);
      expect([d.journal().phase, d.gateOwned(), d.services.running]).toEqual(['released', false, 'old']);
      expect(d.log.filter(one => /bootout|bootstrap/.test(one))).toEqual([]);
    } finally { d.close(); }
  }
});

test('a newly observed catalog is journaled before its backup is awaited', async () => {
  const d = await deployment();
  try {
    let journaled: unknown;
    const runtime = { backupCodingCatalog: async (from: string, to: string) => { journaled = d.journal().codingCatalogExpected; copyFileSync(from, to); } };
    await d.phases.ensureCodingBackup(runtime, { id: randomUUID(), phase: 'frozen' });
    expect(journaled).toBe(true);
    expect(d.journal().codingBackupHash).toMatch(/^[a-f0-9]{64}$/);
  } finally { d.close(); }
});

test('external recovery waits for the deployment lock and reads starting instead of an earlier pre-swap phase', async () => {
  const d = await deployment();
  let child: ReturnType<typeof deploymentChild> | undefined;
  try {
    await d.rehearsed();
    const file = join(d.stage, 'deployment.json');
    child = deploymentChild(`
      import { acquireDeploymentLock } from ${JSON.stringify(new URL('../dist/deploy-lock.js', import.meta.url).href)};
      import { browserDeployment } from ${JSON.stringify(new URL('../scripts/deploy-phases.mjs', import.meta.url).href)};
      const journalFile = ${JSON.stringify(file)};
      process.send('acquiring');
      const deploymentLock = acquireDeploymentLock(journalFile);
      const deployment = browserDeployment({ journalFile, deploymentLock, candidateHead: 'c'.repeat(40) });
      try { process.send({ recovered: deployment.recoverJournal() }); }
      finally { deploymentLock.release(); process.disconnect(); }`);
    expect(await child.message()).toBe('acquiring');
    // The deploy advances while still exclusively owning the journal; recovery must read after it relinquishes.
    d.phases.save(d.journal(), 'starting');
    d.deploymentLock.release();
    expect(await child.message()).toEqual({ recovered: false });
    expect((await child.closed).code).toBe(0);
    expect(d.journal().phase).toBe('starting');
    expect(d.gateOwned()).toBe(true);
    expect(() => d.phases.recoverJournal()).toThrow('not held');
  } finally { await child?.stop(); d.close(); }
});

test('cancellation during coding backup unwinds before recovery and never advances into swap', async () => {
  const d = await deployment();
  try {
    d.hooks.codingBackup = () => { d.cancellation.abort(Error('interrupted')); };
    await expect(d.phases.prepare({ packageSha256: 'staged' })).rejects.toThrow('interrupted');
    expect(d.journal().phase).toBe('frozen');
    expect(quietly(() => d.phases.recoverJournal())).toBe(true);
    expect([d.journal().phase, d.gateOwned()]).toEqual(['released', false]);
    expect(d.log).not.toContain('bootout');
  } finally { d.close(); }
});

test('recovery rechecks the journal immediately before removal and refuses a changed phase', async () => {
  const d = await deployment();
  try {
    await d.rehearsed();
    d.hooks.owned = () => { durableJson(join(d.stage, 'deployment.json'), { ...d.journal(), phase: 'starting' }); };
    expect(quietly(() => d.phases.recoverJournal())).toBe(false);
    expect([d.journal().phase, d.gateOwned()]).toEqual(['starting', true]);
  } finally { d.close(); }
});

test('swap verifies the backups before the stop, proves the stop and custody before migrating, and again before starting the candidate', async () => {
  const d = await deployment();
  try {
    await d.rehearsed();
    // A child that appeared since preparation is stopped and proved gone too.
    d.services.old = { ...d.services.old, children: [fakePid(2), fakePid(3)] };
    let atStop: Record<string, any> | undefined;
    d.hooks.stopped = () => { atStop ??= d.journal(); };
    await d.phases.swap();
    expect(d.log).toEqual([
      'rehearsed', 'stopping', 'bootout', `proved stopped ${fakePid(1)} ${fakePid(2)} ${fakePid(3)}`, 'stopped',
      // Only once every old process is gone does the candidate's own module release a stale owner, before custody is checked.
      'candidate releases stale owner', 'installed custody', 'migrating', 'migrate', 'migrated',
      // Migration loads asynchronously: the stop, the backup and custody are proved again before the candidate starts.
      `proved stopped ${fakePid(1)} ${fakePid(2)} ${fakePid(3)}`, 'installed custody', 'bootstrap candidate', 'starting', 'started',
    ]);
    // The identity being stopped was journaled before the stop.
    expect(atStop).toMatchObject({ phase: 'stopping', stoppingService: { supervisor: fakePid(1), children: [fakePid(2), fakePid(3)] } });
    expect(d.journals.stopped.codingBackupBeforeSwap).toBe(d.journal().codingBackupHash);
    expect(readFileSync(d.plist, 'utf8')).toContain(`${d.nextDist}/cli.js`);
    expect(d.journal()).toMatchObject({ phase: 'started', newService: { supervisor: fakePid(4) } });
  } finally { d.close(); }
});

test('codex round 1 #3: the swap proves up\'s console and worker exited, and hands their pids to the stale-owner release', async () => {
  const d = await deployment();
  try {
    const consolePid = fakePid(8), worker = fakePid(9), restarted = fakePid(10);
    (d.services.old as Record<string, unknown>)['roles'] = [{ role: 'console', pid: consolePid }, { role: 'worker', pid: worker }];
    await d.rehearsed();
    // The worker restarted after preparation: the stop covers the role pids of both records.
    (d.services.old as Record<string, unknown>)['roles'] = [{ role: 'console', pid: consolePid }, { role: 'worker', pid: restarted }];
    let released: number[] = [];
    d.hooks.stopped = pids => { released = pids; };
    await d.phases.swap();
    const all = [fakePid(1), fakePid(2), consolePid, worker, restarted];
    expect(d.log).toContain(`proved stopped ${all.join(' ')}`);
    expect(released).toEqual(all);
    expect(d.journals.stopping.stoppingService.roles).toEqual([{ role: 'console', pid: consolePid }, { role: 'worker', pid: restarted }]);
  } finally { d.close(); }
});

test('a coding catalog that first appears once the candidate runs is backed up after it starts, and journaled', async () => {
  const d = await deployment({ codingCatalog: false });
  try {
    await d.rehearsed();
    expect(d.journal().codingBackupHash ?? null).toBeNull();
    // The candidate makes its first catalog while the swap waits for it to answer.
    d.hooks.sleep = () => { if (!existsSync(`${d.database}.coding.sqlite`)) d.appearCatalog(); };
    await d.phases.swap();
    expect(d.log.slice(d.log.indexOf('starting'))).toEqual(['starting', 'started', 'candidate backs up coding']);
    expect(d.journal()).toMatchObject({ phase: 'started', codingCatalogExpected: true, codingBackupHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  } finally { d.close(); }
});

test('a backup that no longer verifies refuses the swap before anything is stopped, and only the pause is lifted', async () => {
  for (const changed of ['orders', 'coding'] as const) {
    const d = await deployment();
    try {
      await d.rehearsed();
      tamper(changed === 'orders' ? join(d.stage, 'orders.backup.db') : d.codingBackup);
      await expect(d.phases.swap()).rejects.toThrow(changed === 'orders' ? 'The verified backup or rehearsal changed.' : 'retained coding backup');
      expect(d.log).not.toContain('bootout');
      expect(d.journal().phase).toBe('rehearsed');
      expect(quietly(() => d.phases.recoverJournal())).toBe(true);
      expect(d.log.filter(one => one.startsWith('bootstrap'))).toEqual([]);
      expect([d.journal().phase, d.gateOwned()]).toEqual(['released', false]);
    } finally { d.close(); }
  }
});

test('a coding backup changed while the migration loaded leaves the candidate unstarted', async () => {
  const d = await deployment();
  try {
    await d.rehearsed();
    let stops = 0;
    d.hooks.stopped = () => { if (++stops === 2) tamper(d.codingBackup); };
    await expect(d.phases.swap()).rejects.toThrow('retained coding backup');
    expect(d.log.filter(one => one.startsWith('bootstrap'))).toEqual([]);
    expect(readFileSync(d.plist, 'utf8')).toBe(d.livePlist);
    expect(d.journal().phase).toBe('migrated');
  } finally { d.close(); }
});

test('a failed start is stopped and its custody proved, then the backup and previous service go back before admission reopens', async () => {
  const d = await deployment();
  try {
    await d.rehearsed();
    d.services.starts = false;
    await expect(d.phases.swap()).rejects.toThrow('The new service did not come up.');
    const failed = `proved stopped ${fakePid(6)} ${fakePid(7)}`;
    expect(d.log.slice(d.log.indexOf('starting'))).toEqual(['starting', 'bootout', failed, failed, 'candidate custody', 'start-failed']);
    // The verified backup goes back, then the previous service starts and answers, all while admission stays paused.
    const recovering = d.log.length;
    expect(quietly(() => d.phases.recoverJournal())).toBe(true);
    expect(d.log.slice(recovering)).toEqual(['bootstrap previous while paused', 'healthz while paused']);
    expect(readFileSync(d.plist, 'utf8')).toBe(d.livePlist);
    const db = d.orders();
    try {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='candidate_only'").get()).toBeUndefined();
      expect(gate.updateGateOwned(db, d.journal().id)).toBe(false);
    } finally { db.close(); }
    expect(d.journal().phase).toBe('released');
  } finally { d.close(); }
});

test('the previous service is not started on a database it cannot read', async () => {
  const d = await deployment();
  try {
    await d.rehearsed();
    d.services.starts = false;
    await expect(d.phases.swap()).rejects.toThrow('did not come up');
    // Same-schema rehearsal said it reads the result, but the live schema moved on: nothing is started, the pause stays.
    durableJson(join(d.stage, 'deployment.json'), { ...d.journal(), rehearsal: { integrity: 'ok', previousRuntimeCompatible: true } });
    const db = d.orders();
    try { db.exec('UPDATE schema_version SET version=version+1'); } finally { db.close(); }
    const recovering = d.log.length;
    expect(quietly(() => d.phases.recoverJournal())).toBe(false);
    expect(d.log.slice(recovering)).toEqual([]);
    expect([d.journal().phase, d.gateOwned()]).toEqual(['start-failed', true]);
  } finally { d.close(); }
});

/** A started deployment whose project lease is renewed only after finish first waits for it. */
async function started() {
  const d = await deployment();
  await d.rehearsed();
  await d.phases.swap();
  const lease = (heartbeat: string) => { const db = d.orders(); try { db.prepare("INSERT OR REPLACE INTO watch_lease VALUES('worker','/repo','owner',1,?,?,?)").run(heartbeat, new Date(Date.now() + 3_600_000).toISOString(), heartbeat); } finally { db.close(); } };
  lease(new Date(Date.now() - 3_600_000).toISOString());
  d.hooks.sleep = () => { d.log.push('lease wait'); lease(new Date().toISOString()); };
  d.reset();
  return d;
}

test('a fresh prepare refreshes the put-away reservation before writing anything; a refused or missing reservation prepares nothing', async () => {
  const d = await deployment({ codingCatalog: false });
  try {
    const reserved: unknown[] = [];
    d.hooks.reserve = proven => { reserved.push(proven); };
    await d.phases.prepare({ packageSha256: 'staged' });
    expect(reserved).toEqual([d.current]);
    expect(d.journal()).toMatchObject({ phase: 'backup-verified' });
  } finally { d.close(); }
  const refused = await deployment({ codingCatalog: false });
  try {
    refused.hooks.reserve = () => { throw Error('This task is put away. Restore it before deploying.'); };
    await expect(refused.phases.prepare({ packageSha256: 'staged' })).rejects.toThrow('This task is put away.');
    expect(existsSync(join(refused.stage, 'release.json'))).toBe(false);
    expect(existsSync(join(refused.stage, 'deployment.json'))).toBe(false);
  } finally { refused.close(); }
});

test('a deployment given no reservation refuses at its first proving phase, after the read-only proof', () => {
  const root = mkdtempSync(join(tmpdir(), 'toolroll-deploy-noreserve-'));
  try {
    const database = join(root, 'orders.db');
    new DatabaseSync(database).close();
    let proved = 0;
    const phases = browserDeployment({
      database, journalFile: join(root, 'deployment.json'), candidateHead: 'c'.repeat(40), deploymentLock: { assertHeld: () => {} },
      facts: () => { proved++; return {}; }, requireTrue: (okay: unknown, message: string) => { if (!okay) throw Error(message); },
    });
    expect(() => phases.loadPhase('rehearsed')).toThrow("The deployment can't reserve its task against being put away.");
    expect(proved).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a deployment resumed at started proves read-only, then refreshes its put-away reservation before finishing; a refused reservation finishes nothing', async () => {
  const d = await started();
  try {
    const reserved: unknown[] = [];
    d.hooks.facts = db => { expect(() => db.exec('CREATE TABLE written(x)')).toThrow(/readonly/); };
    d.hooks.reserve = proven => { reserved.push(proven); };
    await d.phases.finish();
    expect(reserved).toEqual([d.current]);
    expect(d.journal()).toMatchObject({ phase: 'deployed' });
  } finally { d.close(); }
  const refused = await started();
  try {
    refused.hooks.reserve = () => { throw Error('This task is put away. Restore it before deploying.'); };
    await expect(refused.phases.finish()).rejects.toThrow('This task is put away.');
    expect([refused.journal().phase, refused.gateOwned()]).toEqual(['started', true]);
  } finally { refused.close(); }
});

test('finish asks the local console for 30 s in all, however long each ask takes', async () => {
  const d = await started();
  try {
    const start = 1_000_000;
    let clock = start, asks = 0;
    d.hooks.now = () => clock;
    // Each ask runs to its own bound (5 s) and fails; each pause takes what it was given.
    d.hooks.fetch = () => { asks++; clock += 5_000; throw Error('no answer'); };
    d.hooks.sleep = ms => { clock += ms ?? 0; };
    await expect(d.phases.finish()).rejects.toThrow('The local console does not answer (asked for 30 s).');
    expect(clock - start).toBeLessThanOrEqual(30_000);
    expect(asks).toBe(5);
  } finally { d.close(); }
});

test('finish checks custody before the console answers, waits for fresh leases, and verifies the backups again before reopening admission', async () => {
  const d = await started();
  try {
    await d.phases.finish();
    expect(d.log).toEqual(['started', 'fetch http://127.0.0.1:4180/t/task', 'lease wait', 'healthy', 'deployed', 'summary']);
    expect(d.journal()).toMatchObject({ phase: 'deployed', leases: [{ repo: '/repo' }] });
    expect(d.gateOwned()).toBe(false);
  } finally { d.close(); }
  for (const when of ['fetch', 'sleep'] as const) {
    const changed = await started();
    try {
      const wait = changed.hooks.sleep;
      changed.hooks[when] = () => { if (when === 'sleep') wait?.(); tamper(changed.codingBackup); };
      await expect(changed.phases.finish()).rejects.toThrow('retained coding backup');
      expect([changed.journal().phase, changed.gateOwned()]).toEqual(['started', true]);
    } finally { changed.close(); }
  }
});

test('a configured HTTPS console that does not answer stops prepare before anything is paused', async () => {
  const withConsole = (args: Record<string, any>) => ({ ...args, publicUrl: 'https://console.test' });
  const d = await deployment({ wrap: withConsole });
  try {
    d.hooks.fetch = () => { if (d.log.at(-1)?.startsWith('fetch https://')) throw Error('no answer'); };
    await expect(d.phases.prepare({ packageSha256: 'staged' })).rejects.toThrow('The configured HTTPS console (https://console.test) does not answer, so nothing was paused.');
    expect(d.log).toEqual(['fetch https://console.test/t/task']);
    expect(existsSync(join(d.stage, 'deployment.json'))).toBe(false);
  } finally { d.close(); }
  const answering = await deployment({ wrap: withConsole });
  try {
    await answering.phases.prepare({ packageSha256: 'staged' });
    expect(answering.log.slice(0, 2)).toEqual(['fetch https://console.test/t/task', 'preparing']);
    expect(answering.journal().phase).toBe('backup-verified');
  } finally { answering.close(); }
});

test('a configured HTTPS console that stops answering after prepare stops the swap before the old service is stopped', async () => {
  const d = await deployment({ wrap: args => ({ ...args, publicUrl: 'https://console.test' }) });
  try {
    await d.rehearsed();
    d.hooks.fetch = () => { throw Error('no answer'); };
    await expect(d.phases.swap()).rejects.toThrow('does not answer, so the running service was not stopped.');
    expect(d.log).toEqual(['rehearsed', 'fetch https://console.test/t/task']);
    expect([d.journal().phase, d.services.running, d.gateOwned()]).toEqual(['rehearsed', 'old', true]);
  } finally { d.close(); }
});

/** deploy-browser's database helpers, with the snapshot and the SQLite copy supplied. */
function browserDatabaseHelpers(snapshot: (db: DatabaseSync) => unknown = () => [], copy: typeof backup = backup) {
  return {
    openDeploymentDatabase: openDeploymentDatabase as (file: string, options?: { readOnly?: boolean }, waitMs?: number) => DatabaseSync,
    snapshotBackup: (db: DatabaseSync, target: string, validate?: (db: DatabaseSync) => void) => snapshotBackup(db, target, validate, { snapshot, backup: copy }) as Promise<unknown>,
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
  return browserDeployment({
    candidateHead: 'c'.repeat(40), oldRt: { gate: { updateGateOwned } }, facts, quiet, requireTrue: (okay: unknown, message: string) => { if (!okay) throw Error(message); },
  }).verifyPreparedDatabase as (db: DatabaseSync, record: Record<string, unknown>) => void;
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
  const workspace = new CodingWorkspace({ database: file, worktreeRoot: join(f.root, 'worktrees'), permissions: () => ({ sandbox: 'workspace-write' }) });
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
  const workspace = new CodingWorkspace({ database: file, worktreeRoot: join(f.root, 'worktrees'), permissions: () => ({ sandbox: 'workspace-write' }) });
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

// ---- 2026-10-29: a stuck `up` left behind by its supervisor -----------------------------------------------------

/** The installed runtime's entries, behaving as in the incident: the supervisor forwards SIGTERM and exits at once;
 * `up` and its worker ignore SIGTERM and keep running without it. */
function stuckRuntime(dist: string): void {
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'controller-service.js'), `
    const { spawn } = require('node:child_process');
    const child = spawn(process.argv[2], process.argv.slice(3), { stdio: 'ignore' });
    process.on('SIGTERM', () => { child.kill('SIGTERM'); process.exit(0); });
    setInterval(() => {}, 1000);`);
  writeFileSync(join(dist, 'cli.js'), `
    const { spawn } = require('node:child_process');
    process.on('SIGTERM', () => {});
    spawn(process.execPath, [__dirname + '/up-role-child.js', 'worker'], { stdio: 'ignore' });
    setInterval(() => {}, 1000);`);
  writeFileSync(join(dist, 'up-role-child.js'), "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
}
const pause = (ms: number) => new Promise(done => setTimeout(done, ms));
const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor<T>(what: string, probe: () => T | null | undefined | false, ms = 10_000): Promise<T> {
  for (const deadline = Date.now() + ms; ;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw Error(`timed out waiting for ${what}`);
    await pause(50);
  }
}
/** A real service tree of the installed runtime on `db`: supervisor → `up` → worker. */
async function stuckService(dist: string, db: string, spawned: ChildProcess[]) {
  const supervisor = spawn(process.execPath, [join(dist, 'controller-service.js'), process.execPath, join(dist, 'cli.js'), 'up', '--db', db, '--port', '4180'], { stdio: 'ignore' });
  spawned.push(supervisor);
  const up = await waitFor('its up', () => listProcesses(realSpawnSync)?.find(row => row.ppid === supervisor.pid && row.command.includes('cli.js up')));
  const role = await waitFor('its worker', () => listProcesses(realSpawnSync)?.find(row => row.ppid === up.pid && row.command.endsWith('up-role-child.js worker')));
  return { supervisor: supervisor.pid!, up: up.pid, role: role.pid };
}
/** The fixture with the real stop proof and escalation over real processes; launchd's bootout sends the supervisor
 * its SIGTERM, as launchd does. */
async function stuckDeployment() {
  const spawned: ChildProcess[] = [];
  const tree: { supervisor: number; up: number; role: number }[] = [];
  let stopper: ReturnType<typeof serviceStopper> | null = null;
  const d = await deployment({ wrap: args => {
    stopper = serviceStopper({ database: args['database'], spawnSync: realSpawnSync, kill: (pid: number, signal: NodeJS.Signals) => process.kill(pid, signal), sleep: pause, say: args['say'],
      loaded: () => false, graceMs: 500, termMs: 500, killMs: 5_000 });
    const fake = args['spawnSync'];
    return { ...args, leftFrom: stopper.leftFrom, processes: stopper.processes, stopProcesses: stopper.stopProcesses,
      verifyServiceStopped: async (pids: number[], dist: string) => { args['say']?.(`• proving ${pids.length} processes stopped`); await stopper!.verifyServiceStopped(pids, dist); },
      spawnSync: (command: string, argv: string[], options: unknown) => {
        if (basename(command) === 'launchctl' && argv[0] === 'bootout') for (const one of tree) { try { process.kill(one.supervisor, 'SIGTERM'); } catch { /* gone */ } }
        return fake(command, argv, options);
      } };
  } });
  const priorDist = join(d.root, 'installed', 'dist');
  stuckRuntime(priorDist);
  const old = await stuckService(priorDist, d.database, spawned);
  tree.push(old);
  d.services.old = { supervisor: old.supervisor, children: [old.up], commands: [], roles: [{ role: 'worker', pid: old.role }] } as typeof d.services.old;
  return { d, old, priorDist, spawned, stopper: () => stopper!,
    close: () => {
      // Everything this test started, whatever happened: every process running from its folder.
      for (const row of listProcesses(realSpawnSync) ?? []) if (row.command.includes(d.root) || row.command.includes(realpathSync(d.root))) { try { process.kill(row.pid, 'SIGKILL'); } catch { /* gone */ } }
      for (const child of spawned) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      d.close();
    } };
}

test('a stuck service refuses the swap without signalling historical PIDs', async () => {
  const s = await stuckDeployment();
  try {
    await s.d.rehearsed();
    await expect(s.d.phases.swap()).rejects.toThrow('Historical PIDs');
    expect([s.old.up, s.old.role].every(isAlive)).toBe(true);
    expect(s.d.journal().phase).toBe('stopping');
    expect(s.d.gateOwned()).toBe(true);
    expect(s.d.log).not.toContain('bootstrap candidate');
  } finally { s.close(); }
}, 60_000);

test('recovery leaves live services untouched, then restores only after the owner stops the old processes', async () => {
  const s = await stuckDeployment();
  const sandbox: ChildProcess[] = [];
  try {
    await s.d.rehearsed();
    // The old deployment's stop: waited, never escalated, and left the journal at stopping with the orphan running.
    const r = s.d.journal();
    s.d.phases.save({ ...r, stoppingService: s.d.services.old }, 'stopping');
    process.kill(s.old.supervisor, 'SIGTERM');
    await waitFor('the supervisor to exit', () => !isAlive(s.old.supervisor));
    // That stop booted the label out; what is left is processes, which the real process table answers for.
    s.d.services.running = null;
    // The same runtime serving a sandbox's database: never this deployment's, never touched.
    const other = await stuckService(s.priorDist, join(s.d.root, 'demo.db'), sandbox);
    s.d.reset();
    expect(quietly(() => s.d.phases.recoverJournal())).toBe(false);
    expect([s.old.up, s.old.role, other.supervisor, other.up, other.role].every(isAlive)).toBe(true);
    expect(s.d.gateOwned()).toBe(true);
    for (const pid of [s.old.up, s.old.role]) process.kill(pid, 'SIGKILL');
    await waitFor('the owned processes to exit', () => ![s.old.up, s.old.role].some(isAlive));
    expect(quietly(() => s.d.phases.recoverJournal())).toBe(true);
    expect([isAlive(s.old.up), isAlive(s.old.role)]).toEqual([false, false]);
    expect([other.supervisor, other.up, other.role].every(isAlive)).toBe(true);
    expect(s.d.log).toEqual(expect.arrayContaining(['bootstrap previous while paused', 'healthz while paused']));
    expect([s.d.journal().phase, s.d.gateOwned()]).toEqual(['released', false]);
    // Idempotent: run again, nothing left to do.
    s.d.reset();
    expect(quietly(() => s.d.phases.recoverJournal())).toBe(true);
    for (const pid of [other.role, other.up, other.supervisor]) process.kill(pid, 'SIGKILL');
  } finally { for (const child of sandbox) { try { child.kill('SIGKILL'); } catch { /* gone */ } } s.close(); }
}, 60_000);

test.each(['stopped', 'migrated', 'backup-restored'])('recovery at %s leaves a healthy replacement and its database untouched', async phase => {
  const d = await deployment();
  try {
    await d.rehearsed();
    durableJson(join(d.stage, 'deployment.json'), { ...d.journal(), phase });
    d.services.running = 'new';
    const before = readFileSync(d.database), definition = readFileSync(d.plist, 'utf8');
    d.reset();
    expect(quietly(() => d.phases.recoverJournal())).toBe(false);
    expect(d.services.running).toBe('new');
    expect(d.log).not.toContain('bootout');
    expect(readFileSync(d.database)).toEqual(before);
    expect(readFileSync(d.plist, 'utf8')).toBe(definition);
    expect(d.gateOwned()).toBe(true);
  } finally { d.close(); }
});

// A deployment killed while it waited for the new service (docs/plans/deploy-phase-table.md). The journal says
// "starting" and nothing recorded whether the service came up.

test('finish at starting only looks: a new service that is running moves the journal to started and the deployment finishes', async () => {
  const d = await killedAtStarting();
  try {
    const lease = (heartbeat: string) => { const db = d.orders(); try { db.prepare("INSERT OR REPLACE INTO watch_lease VALUES('worker','/repo','owner',1,?,?,?)").run(heartbeat, new Date(Date.now() + 3_600_000).toISOString(), heartbeat); } finally { db.close(); } };
    lease(new Date(Date.now() - 3_600_000).toISOString());
    d.hooks.sleep = () => { d.log.push('lease wait'); lease(new Date().toISOString()); };
    await d.phases.finish();
    expect(d.log).toEqual(['started', 'fetch http://127.0.0.1:4180/t/task', 'lease wait', 'healthy', 'deployed', 'summary']);
    expect(d.journals['started']).toMatchObject({ phase: 'started', newService: d.services.new });
    expect(d.journal()).toMatchObject({ phase: 'deployed', leases: [{ repo: '/repo' }] });
    expect([d.gateOwned(), d.services.running, migratedRows(d)]).toEqual([false, 'new', true]);
  } finally { d.close(); }
});

test('finish at starting waits no longer than the swap would for a loaded service, not at all for one launchd does not have, and changes nothing', async () => {
  const { HEALTH_WAIT_MS } = await import('../scripts/deploy-recovery.mjs');
  for (const [running, waits] of [['failed', HEALTH_WAIT_MS / 1000], [null, 0]] as const) {
    const d = await killedAtStarting({ starts: false });
    try {
      d.services.running = running;
      let slept = 0;
      d.hooks.sleep = () => { slept++; };
      await expect(d.phases.finish()).rejects.toThrow('The new service is not running from the new runtime. Nothing was stopped and the journal stays at starting.');
      expect([running, slept]).toEqual([running, waits]);
      expect(d.log.filter(line => /bootout|bootstrap|custody|healthz/.test(line))).toEqual([]);
      expect([d.journal().phase, d.gateOwned(), d.services.running, migratedRows(d)]).toEqual(['starting', true, running, true]);
    } finally { d.close(); }
  }
});

test('finish at starting does not call a service started unless the database is the migrated one under this deployment\'s pause', async () => {
  const lost = await killedAtStarting();
  try {
    const db = lost.orders();
    try { removeUpdateGate(db, lost.journal().id); } finally { db.close(); }
    await expect(lost.phases.finish()).rejects.toThrow("The live database is not the migrated one under this deployment's pause. Nothing was stopped and the journal stays at starting.");
    expect([lost.journal().phase, lost.journal().newService, lost.services.running]).toEqual(['starting', undefined, 'new']);
  } finally { lost.close(); }
  const moved = await killedAtStarting();
  try {
    const db = moved.orders();
    try { db.exec('UPDATE schema_version SET version=version+1'); } finally { db.close(); }
    await expect(moved.phases.finish()).rejects.toThrow("The live database is not the migrated one under this deployment's pause.");
    expect([moved.journal().phase, moved.gateOwned(), moved.services.running]).toEqual(['starting', true, 'new']);
  } finally { moved.close(); }
});

test('recovery at starting stops nothing; once the new service is proved gone it is journaled a failed start and undone like one', async () => {
  // Loaded, and never starting completely, from a stage outside Toolroll's own folder (this fixture's temp root): left
  // to a person. In Toolroll's own folder recovery stops it itself once it proves it may (deploy-new-service-stop.slow.test.ts).
  const d = await killedAtStarting({ starts: false });
  try {
    expect(quietly(() => d.phases.recoverJournal())).toBe(false);
    await expect(d.phases.proveStartFailed()).rejects.toThrow(/The new service is still loaded or still has processes, so the previous one was not put back\. Nothing was stopped and the journal stays at starting\..*launchctl bootout gui\/501\/com\.toolroll\.browser/);
    expect(d.log).toEqual([]);
    expect([d.journal().phase, d.gateOwned(), d.services.running, migratedRows(d)]).toEqual(['starting', true, 'failed', true]);
    // The journal alone still restores nothing, however often it is asked.
    expect(quietly(() => d.phases.recoverJournal())).toBe(false);
    expect(d.log).toEqual([]);
    // Its owner stopped it. Now gone is provable: the same custody checks a failed start gets, then the failed start's own recovery.
    d.services.running = null;
    expect(quietly(() => d.phases.recoverJournal())).toBe(false);
    expect(d.journal().phase).toBe('starting');
    expect(await d.phases.proveStartFailed()).toBe(true);
    expect(d.log).toEqual(['starting', 'candidate custody', 'start-failed']);
    expect([d.journal().phase, d.gateOwned(), migratedRows(d)]).toEqual(['start-failed', true, true]);
    const recovering = d.log.length;
    expect(quietly(() => d.phases.recoverJournal())).toBe(true);
    expect(d.log.slice(recovering)).toEqual(['bootstrap previous while paused', 'healthz while paused']);
    expect(readFileSync(d.plist, 'utf8')).toBe(d.livePlist);
    expect([d.journal().phase, d.gateOwned(), d.services.running, migratedRows(d)]).toEqual(['released', false, 'old', false]);
    // Asked again, it has nothing to prove.
    expect(await d.phases.proveStartFailed()).toBe(false);
  } finally { d.close(); }
});

test('a start is never journaled failed while the new service runs, from another context, without the pause, or without the new runtime\'s own proofs', async () => {
  const refuse = { custody: false, staged: false };
  const wrap = (args: Record<string, any>) => ({
    ...args,
    proveStaged: () => { if (refuse.staged) throw Error('Staged file differs from a clean build of the candidate commit: cli.js'); return args.proveStaged(); },
    loadCodingDeploymentRuntime: async (dist: string) => {
      const runtime = await args.loadCodingDeploymentRuntime(dist);
      return refuse.custody && dist === args.nextDist ? { ...runtime, assertCodingUpdateStopped: () => { throw Error('A coding agent of the new runtime is still running.'); } } : runtime;
    },
  });
  const cases: readonly (readonly [string, (d: Awaited<ReturnType<typeof deployment>>) => void, string | RegExp])[] = [
    ['the new service answers', d => { d.services.running = 'new'; }, 'still loaded or still has processes'],
    ['a previous runtime other than the one this run reads', d => durableJson(join(d.stage, 'deployment.json'), { ...d.journal(), priorRuntime: join(d.root, 'older', 'dist') }), "does not match the deployment's recorded runtimes, database or commit"],
    ['another staging directory', d => durableJson(join(d.stage, 'deployment.json'), { ...d.journal(), nextRuntime: join(d.root, 'elsewhere', 'dist') }), "does not match the deployment's recorded runtimes, database or commit"],
    ['another commit', d => durableJson(join(d.stage, 'deployment.json'), { ...d.journal(), candidate: 'd'.repeat(40) }), "does not match the deployment's recorded runtimes, database or commit"],
    ['another database', d => durableJson(join(d.stage, 'deployment.json'), { ...d.journal(), database: join(d.root, 'demo.db') }), "does not match the deployment's recorded runtimes, database or commit"],
    ['the pause is no longer this deployment\'s', d => { const db = d.orders(); try { removeUpdateGate(db, d.journal().id); } finally { db.close(); } }, /New work is no longer paused by this deployment \(update [0-9a-f-]{36}\)/],
    ['the staged runtime is not the recorded commit', () => { refuse.staged = true; }, 'Staged file differs from a clean build'],
    ['a coding agent of the new runtime is left', () => { refuse.custody = true; }, 'A coding agent of the new runtime is still running.'],
  ];
  for (const [name, arrange, words] of cases) {
    Object.assign(refuse, { custody: false, staged: false });
    const d = await killedAtStarting({ starts: false, wrap });
    try {
      d.services.running = null;
      arrange(d);
      const before = readFileSync(d.database);
      await expect(d.phases.proveStartFailed(), name).rejects.toThrow(words);
      expect([name, d.journal().phase, migratedRows(d)]).toEqual([name, 'starting', true]);
      expect(d.log.filter(line => /bootout|bootstrap|healthz|start-failed/.test(line)), name).toEqual([]);
      expect(readFileSync(d.database).equals(before), name).toBe(true);
      // And the recovery that follows it in --phase recover still puts nothing back.
      expect(quietly(() => d.phases.recoverJournal()), name).toBe(false);
      expect(d.log.filter(line => /bootout|bootstrap|healthz/.test(line)), name).toEqual([]);
    } finally { d.close(); }
  }
  // Any other phase: nothing to prove, nothing written.
  const other = await started();
  try {
    const before = readFileSync(join(other.stage, 'deployment.json'), 'utf8');
    expect(await other.phases.proveStartFailed()).toBe(false);
    expect(readFileSync(join(other.stage, 'deployment.json'), 'utf8')).toBe(before);
  } finally { other.close(); }
});

test('the backup and the previous service go back only from the run that reads the definition the deployment replaced', async () => {
  const d = await deployment();
  try {
    await d.rehearsed();
    d.services.starts = false;
    await expect(d.phases.swap()).rejects.toThrow('The new service did not come up.');
    // A run that reads the installed (new) definition has another "previous" runtime than the journal's.
    durableJson(join(d.stage, 'deployment.json'), { ...d.journal(), priorRuntime: join(d.root, 'older', 'dist') });
    const recovering = d.log.length;
    expect(quietly(() => d.phases.recoverJournal())).toBe(false);
    expect(d.log.slice(recovering)).toEqual([]);
    expect([d.journal().phase, d.gateOwned(), migratedRows(d)]).toEqual(['start-failed', true, true]);
    // (From the deployment's own saved definition it goes back: 'a failed start is stopped and its custody proved' above.)
  } finally { d.close(); }
});

// Codex build review, round 2 (docs/plans/deploy-phase-table.md): each phase is its own run of the script, with its
// own reading of the service definition; launchd's label is a fact apart from the processes; and the service is told
// by exact runtime and exact database.

/** A swap whose new service never came up: stopped in-process, journaled "start-failed", nothing put back yet. */
async function failedStart({ compatible = false }: { compatible?: boolean } = {}) {
  const d = await deployment();
  await d.rehearsed();
  if (compatible) durableJson(join(d.stage, 'deployment.json'), { ...d.journal(), rehearsal: { integrity: 'ok', previousRuntimeCompatible: true } });
  d.services.starts = false;
  await expect(d.phases.swap()).rejects.toThrow('The new service did not come up.');
  expect([d.journal().phase, d.services.running]).toEqual(['start-failed', null]);
  d.reset();
  return d;
}

test('finish at starting, as its own run reading the installed definition, finishes; that run puts nothing back, and the recover run does', async () => {
  const d = await killedAtStarting();
  try {
    // The run that follows the kill: the installed definition names the new runtime, so that is its "previous" one.
    expect(readFileSync(d.plist, 'utf8')).toBe(readFileSync(join(d.stage, 'browser.next.plist'), 'utf8'));
    const lease = (heartbeat: string) => { const db = d.orders(); try { db.prepare("INSERT OR REPLACE INTO watch_lease VALUES('worker','/repo','owner',1,?,?,?)").run(heartbeat, new Date(Date.now() + 3_600_000).toISOString(), heartbeat); } finally { db.close(); } };
    lease(new Date(Date.now() - 3_600_000).toISOString());
    d.hooks.sleep = () => { d.log.push('lease wait'); lease(new Date().toISOString()); };
    await d.asFinish().finish();
    expect(d.log).toEqual(['started', 'fetch http://127.0.0.1:4180/t/task', 'lease wait', 'healthy', 'deployed', 'summary']);
    expect([d.journal().phase, d.gateOwned(), d.services.running, migratedRows(d)]).toEqual(['deployed', false, 'new', true]);
  } finally { d.close(); }

  const failed = await failedStart();
  try {
    const before = readFileSync(failed.database), definition = readFileSync(failed.plist, 'utf8');
    // A finish (or any phase but recover) that exits at a failed start runs the same recovery on its way out.
    const refused = said(() => failed.asFinish().recoverJournal());
    expect(refused.result).toBe(false);
    expect(refused.words).toContain(`This run reads the service definition the deployment installed, not the one it replaced; nothing was put back. Use --phase recover with --stage ${failed.stage}.`);
    expect(failed.log).toEqual([]);
    expect([readFileSync(failed.database).equals(before), readFileSync(failed.plist, 'utf8') === definition]).toEqual([true, true]);
    expect([failed.journal().phase, failed.gateOwned(), migratedRows(failed)]).toEqual(['start-failed', true, true]);
    // --phase recover --stage reads the definition saved at preparation.
    expect(quietly(() => failed.asRecover().recoverJournal())).toBe(true);
    expect(failed.log).toEqual(['bootstrap previous while paused', 'healthz while paused']);
    expect(readFileSync(failed.plist, 'utf8')).toBe(failed.livePlist);
    expect([failed.journal().phase, failed.gateOwned(), failed.services.running, migratedRows(failed)]).toEqual(['released', false, 'old', false]);
  } finally { failed.close(); }
});

test('recover at starting, as its own run: a new service proved gone is journaled failed and undone; one that runs is left alone', async () => {
  const gone = await killedAtStarting({ starts: false });
  try {
    gone.services.running = null;
    const recover = gone.asRecover();
    expect(await recover.proveStartFailed()).toBe(true);
    expect(quietly(() => recover.recoverJournal())).toBe(true);
    expect(gone.log).toEqual(['starting', 'candidate custody', 'start-failed', 'bootstrap previous while paused', 'healthz while paused']);
    expect(readFileSync(gone.plist, 'utf8')).toBe(gone.livePlist);
    expect([gone.journal().phase, gone.gateOwned(), gone.services.running, migratedRows(gone)]).toEqual(['released', false, 'old', false]);
  } finally { gone.close(); }

  const up = await killedAtStarting();
  try {
    const before = readFileSync(up.database), definition = readFileSync(up.plist, 'utf8');
    const recover = up.asRecover();
    await expect(recover.proveStartFailed()).rejects.toThrow('The new service is still loaded or still has processes');
    expect(readFileSync(up.database).equals(before)).toBe(true);
    // (The recovery that follows keeps the deployment's timeline in the database; it restores and starts nothing.)
    expect(quietly(() => recover.recoverJournal())).toBe(false);
    expect(up.log).toEqual([]);
    expect(readFileSync(up.plist, 'utf8')).toBe(definition);
    expect([up.journal().phase, up.gateOwned(), up.services.running, migratedRows(up)]).toEqual(['starting', true, 'new', true]);
  } finally { up.close(); }
});

test('a label launchd holds with no process, or processes left with no label, is never taken for a stopped service', async () => {
  const { HEALTH_WAIT_MS } = await import('../scripts/deploy-recovery.mjs');
  const arrangements: readonly (readonly [string, (d: Awaited<ReturnType<typeof deployment>>) => void])[] = [
    ['loaded, no process', d => { d.services.running = null; d.services.loaded = true; }],
    ['processes, no label', d => { d.services.running = 'failed'; d.services.loaded = false; }],
  ];
  for (const [name, arrange] of arrangements) {
    // Killed at starting: finish does not call it started, recover does not call it failed.
    const d = await killedAtStarting({ starts: false });
    try {
      arrange(d);
      const before = readFileSync(d.database), definition = readFileSync(d.plist, 'utf8');
      let slept = 0;
      d.hooks.sleep = () => { slept++; };
      await expect(d.asFinish().finish(), name).rejects.toThrow('The new service is not running from the new runtime. Nothing was stopped and the journal stays at starting.');
      // A loaded label is waited for as long as the swap would; nothing starts one launchd does not have.
      expect([name, slept]).toEqual([name, d.services.loaded ? HEALTH_WAIT_MS / 1000 : 0]);
      const recover = d.asRecover();
      await expect(recover.proveStartFailed(), name).rejects.toThrow(/still loaded or still has processes.*launchctl bootout gui\/501\/com\.toolroll\.browser/);
      expect([name, readFileSync(d.database).equals(before)]).toEqual([name, true]);
      expect(quietly(() => recover.recoverJournal()), name).toBe(false);
      expect(d.log, name).toEqual([]);
      expect([name, readFileSync(d.plist, 'utf8') === definition]).toEqual([name, true]);
      expect([name, d.journal().phase, d.gateOwned(), migratedRows(d)]).toEqual([name, 'starting', true, true]);
    } finally { d.close(); }

    // A failed start already journaled: nothing is put back, neither the definition nor the database.
    const failed = await failedStart();
    try {
      arrange(failed);
      const before = readFileSync(failed.database), definition = readFileSync(failed.plist, 'utf8');
      const refused = said(() => failed.asRecover().recoverJournal());
      expect([name, refused.result]).toEqual([name, false]);
      expect(refused.words, name).toContain('The service is not proved stopped; its database and definition were left in place.');
      expect(failed.log, name).toEqual([]);
      expect([name, readFileSync(failed.database).equals(before), readFileSync(failed.plist, 'utf8') === definition]).toEqual([name, true, true]);
      expect([name, failed.journal().phase, failed.gateOwned(), migratedRows(failed)]).toEqual([name, 'start-failed', true, true]);
    } finally { failed.close(); }
  }
});

test('finish at starting calls a service started only when it is this deployment\'s: its definition, its runtime, its database', async () => {
  const kept = 'Nothing was stopped and the journal stays at starting.';
  const cases: readonly (readonly [string, (d: Awaited<ReturnType<typeof deployment>>) => void, string])[] = [
    ['the installed definition was replaced', d => writeFileSync(d.plist, readFileSync(d.plist, 'utf8').replace('<string>worker</string>', '<string>local</string>')), `The installed service definition is not the one this deployment installed. ${kept}`],
    ['the definition this deployment wrote is gone', d => rmSync(join(d.stage, 'browser.next.plist')), `The installed service definition is not the one this deployment installed. ${kept}`],
    ['the definition this deployment wrote was changed to match', d => { const other = readFileSync(d.plist, 'utf8').replaceAll(d.nextDist, join(d.root, 'elsewhere', 'dist')); writeFileSync(d.plist, other); writeFileSync(join(d.stage, 'browser.next.plist'), other); }, `The installed service definition is not the one this deployment installed. ${kept}`],
    ['the new runtime serves a database whose path only begins with this one\'s', d => { d.services.newDatabase = `${d.database}-other`; }, `The new service is not running from the new runtime. ${kept}`],
    ['the new runtime serves another database', d => { d.services.newDatabase = join(d.root, 'demo.db'); }, `The new service is not running from the new runtime. ${kept}`],
  ];
  for (const [name, arrange, words] of cases) {
    const d = await killedAtStarting();
    try {
      arrange(d);
      const before = readFileSync(d.database), definition = readFileSync(d.plist, 'utf8');
      // In the run that was killed's own terms, and as the run that follows it.
      await expect(d.phases.finish(), name).rejects.toThrow(words);
      if (definition.includes(`${d.nextDist}/cli.js`)) await expect(d.asFinish().finish(), name).rejects.toThrow(words);
      expect(d.log.filter(line => /bootout|bootstrap|custody|healthz|started/.test(line)), name).toEqual([]);
      expect([name, readFileSync(d.database).equals(before), readFileSync(d.plist, 'utf8') === definition]).toEqual([name, true, true]);
      expect([name, d.journal().phase, d.journal().newService, d.gateOwned(), d.services.running]).toEqual([name, 'starting', undefined, true, 'new']);
    } finally { d.close(); }
  }
});

test('a rollback puts the previous definition back before the database, and restores no database once the label is loaded', async () => {
  // The backup no longer verifies: the database is left as it is, and what a load would start is already the
  // previous runtime (which refuses a newer database), not the new one.
  const d = await failedStart();
  try {
    tamper(d.journal().backup);
    const before = readFileSync(d.database);
    const refused = said(() => d.asRecover().recoverJournal());
    expect(refused.result).toBe(false);
    expect(refused.words).toMatch(/the verified backup .* is missing or changed/i);
    expect(readFileSync(d.plist, 'utf8')).toBe(d.livePlist);
    expect(readFileSync(d.database).equals(before)).toBe(true);
    expect(d.log).toEqual([]);
    expect([d.journal().phase, d.gateOwned(), d.services.running, migratedRows(d)]).toEqual(['start-failed', true, null, true]);
  } finally { d.close(); }

  // Something loads the label just as the definition goes back (a login, a person): absence is proved again after
  // the write, and the database is not restored under a loaded service.
  const raced = await failedStart();
  try {
    const before = readFileSync(raced.database);
    raced.hooks.print = () => { if (readFileSync(raced.plist, 'utf8') === raced.livePlist) raced.services.running = 'old'; };
    const refused = said(() => raced.asRecover().recoverJournal());
    expect(refused.result).toBe(false);
    expect(refused.words).toContain('The service was loaded while its previous definition was put back; the database was left as it is.');
    expect(readFileSync(raced.database).equals(before)).toBe(true);
    expect(raced.log).toEqual([]);
    expect([raced.journal().phase, raced.gateOwned(), migratedRows(raced)]).toEqual(['start-failed', true, true]);
    // Its owner stops it; the same recovery then finishes.
    delete raced.hooks.print;
    raced.services.running = null;
    expect(quietly(() => raced.asRecover().recoverJournal())).toBe(true);
    expect(raced.log).toEqual(['bootstrap previous while paused', 'healthz while paused']);
    expect([raced.journal().phase, raced.gateOwned(), raced.services.running, migratedRows(raced)]).toEqual(['released', false, 'old', false]);
  } finally { raced.close(); }
});

test('a failed start whose result the previous runtime reads keeps the live database: only the service goes back', async () => {
  const d = await failedStart({ compatible: true });
  try {
    const recovered = said(() => d.asRecover().recoverJournal());
    expect(recovered.result).toBe(true);
    expect(recovered.words).toContain('the previous service is running again and new work resumed.');
    expect(recovered.words).not.toContain('put back from the backup');
    expect(d.log).toEqual(['bootstrap previous while paused', 'healthz while paused']);
    expect(readFileSync(d.plist, 'utf8')).toBe(d.livePlist);
    // Nothing was copied aside and nothing restored: what the new runtime wrote is still there.
    expect(readdirSync(d.stage).filter(name => name.includes('.kept.'))).toEqual([]);
    expect([d.journal().phase, d.gateOwned(), d.services.running, migratedRows(d)]).toEqual(['released', false, 'old', true]);
  } finally { d.close(); }
});

test('the journal is never written with a word that is not a phase', async () => {
  const d = await deployment();
  try {
    await d.rehearsed();
    const before = readFileSync(join(d.stage, 'deployment.json'), 'utf8');
    expect(() => d.phases.save(d.journal(), 'almost-started')).toThrow('"almost-started" is not a deployment phase; the journal was not written.');
    expect(readFileSync(join(d.stage, 'deployment.json'), 'utf8')).toBe(before);
  } finally { d.close(); }
});
