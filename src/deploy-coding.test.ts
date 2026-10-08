import { test, expect, vi } from 'vitest';
import { copyFileSync, mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, statSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { openStore } from './store.js';
import { CodingWorkspace } from './coding-workspace.js';
import * as gate from './desktop-update-gate.js';
import { installUpdateGate, freezeUpdateGate, removeUpdateGate, updateGateOwned } from './desktop-update-gate.js';
import { durableJson } from './desktop-update.js';
import { loadCodingDeploymentRuntime, observeCodingDeployment, backupCodingDeployment, verifyCodingDeploymentBackup, assertCodingDeploymentStopped, releaseStaleCodingDeployment } from '../scripts/deploy-coding.mjs';
import { browserDeployment, openDeploymentDatabase, snapshotBackup } from '../scripts/deploy-phases.mjs';
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

/** A deployment run through deploy-browser's own phases (scripts/deploy-phases.mjs) against a real orders database,
 * coding catalog, journal and backups in a scratch folder. launchd, ps, pgrep, curl, the installed and staged
 * runtimes and the plane's records are recorded fakes. `log` holds what happened, in order: each journaled phase
 * once, and every service, custody, backup, migration and network effect. */
async function deployment({ codingCatalog = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'so-browser-phases-'));
  const database = join(root, 'orders.db'), stage = join(root, 'stage'), plist = join(root, 'browser.plist');
  const priorDist = join(root, 'installed', 'dist'), nextDist = join(stage, 'runtime', 'node_modules', 'toolroll', 'dist');
  const journalFile = join(stage, 'deployment.json'), codingBackup = join(stage, 'coding.backup.sqlite');
  mkdirSync(stage);
  openStore(database).close();
  // A real coding catalog, kept aside so a test can make one appear partway through.
  const catalog = join(root, 'catalog.sqlite');
  await new CodingWorkspace({ database: catalog, worktreeRoot: join(root, 'worktrees') }).close();
  const appearCatalog = () => copyFileSync(catalog, `${database}.coding.sqlite`);
  if (codingCatalog) appearCatalog();
  const livePlist = `<string>${priorDist}/cli.js</string><string>--runner</string><string>worker</string>`;
  writeFileSync(plist, livePlist);
  writeFileSync(join(root, 'repos.json'), JSON.stringify({ repos: ['/repo'] }));
  writeFileSync(join(stage, 'candidate.tgz'), 'packed candidate');
  const schema = (() => { const db = new DatabaseSync(database, { readOnly: true }); try { return Number(db.prepare('SELECT version FROM schema_version').get()?.version); } finally { db.close(); } })();

  const log: string[] = [];
  const journals: Record<string, Record<string, any>> = {};
  const hooks: { stopped?: (pids: number[]) => void; sleep?: () => void; fetch?: () => void; install?: () => void; freeze?: () => void; codingBackup?: () => void; facts?: (db: DatabaseSync) => void } = {};
  const current = { completion: { digest: 'complete', actor: 'lead' }, gateDigest: 'check', taskId: 'task', repo: '/repo', scopeDigest: 'scope' };
  const services = {
    old: { supervisor: fakePid(1), children: [fakePid(2)], commands: [] as string[] },
    new: { supervisor: fakePid(4), children: [fakePid(5)], commands: ['node cli.js up'] },
    failed: [fakePid(6), fakePid(7)],
    running: 'old' as 'old' | 'new' | 'failed' | null,
    starts: true,
  };
  const coding = (who: string) => ({
    backupCodingCatalog: async (from: string, to: string) => { log.push(`${who} backs up coding`); hooks.codingBackup?.(); copyFileSync(from, to); },
    assertCodingUpdateStopped: () => { log.push(`${who} custody`); },
    releaseStaleCodingOwner: () => { log.push(`${who} releases stale owner`); return null; },
  });
  const installed = coding('installed'), candidate = coding('candidate');
  const gateEffects = {
    ...gate,
    installUpdateGate: (db: DatabaseSync, id: string) => { hooks.install?.(); gate.installUpdateGate(db, id); },
    freezeUpdateGate: (db: DatabaseSync, id: string) => { const frozen = gate.freezeUpdateGate(db, id); hooks.freeze?.(); return frozen; },
  };
  const paused = () => { const db = new DatabaseSync(database); try { return gate.updateAdmissionPaused(db) ? ' while paused' : ''; } finally { db.close(); } };
  let lastPhase = '';
  const phases = browserDeployment({
    database, stageDir: stage, stateDir: root, journalFile, plist, livePlist, priorDist, nextDist, uid: 501, label: 'com.toolroll.browser', servicePort: '4180',
    runId: 7, candidateHead: 'c'.repeat(40), publicUrl: null, script: 'scripts/deploy-browser.mjs --phase',
    oldRt: { gate: gateEffects, update: { durableJson }, coding: installed },
    facts: (db: DatabaseSync) => { hooks.facts?.(db); return structuredClone(current); },
    quiet: () => {},
    service: (dist: string) => {
      if (dist === nextDist && services.running === 'new') return services.new;
      return dist === priorDist && services.running === 'old' ? services.old : null;
    },
    proveStaged: () => ({ distFiles: 1 }),
    verifyServiceStopped: async (pids: number[]) => { log.push(`proved stopped ${pids.join(' ')}`); hooks.stopped?.(pids); },
    load: async () => ({ SCHEMA_VERSION: schema, openStore: (file: string) => { log.push('migrate'); const db = new DatabaseSync(file); db.exec('CREATE TABLE candidate_only(value)'); return db; } }),
    loadCodingDeploymentRuntime: async (dist: string) => dist === nextDist ? candidate : installed,
    spawnSync: (command: string, args: string[]) => {
      const name = `${basename(command)} ${args[0]}`;
      if (name === 'launchctl bootout') { log.push('bootout'); services.running = null; }
      if (name === 'launchctl bootstrap') {
        const next = readFileSync(plist, 'utf8').includes(nextDist);
        log.push(next ? 'bootstrap candidate' : `bootstrap previous${paused()}`);
        services.running = !next ? 'old' : services.starts ? 'new' : 'failed';
        return { status: 0, stderr: '' };
      }
      if (name === 'launchctl print') return services.running === 'failed' ? { status: 0, stdout: `\n\tpid = ${services.failed[0]}` } : { status: 113, stdout: '' };
      if (name === 'pgrep -P') return { status: 0, stdout: `${services.failed[1]}\n` };
      if (name === 'curl -fsS') { log.push(`healthz${paused()}`); return { status: 0, stdout: '{"status":"ok"}' }; }
      return { status: 1, stdout: '' };
    },
    fetch: async (url: string) => { log.push(`fetch ${url}`); hooks.fetch?.(); return { ok: true, status: 200 }; },
    sleep: async () => { hooks.sleep?.(); },
    say: (message: unknown) => {
      if (typeof message !== 'string') { log.push('summary'); return; }
      const phase = message.replace(/^• /, '');
      if (phase === lastPhase) return;
      lastPhase = phase; log.push(phase);
      journals[phase] ??= JSON.parse(readFileSync(journalFile, 'utf8'));
    },
    requireTrue: (okay: unknown, message: string) => { if (!okay) throw Error(message); },
    pruneStaged: async () => [],
  });
  const journal = () => JSON.parse(readFileSync(journalFile, 'utf8')) as Record<string, any>;
  const orders = () => new DatabaseSync(database);
  const gateOwned = () => { const db = orders(); try { return gate.updateGateOwned(db, journal().id); } finally { db.close(); } };
  /** Prepared, then rehearsed as a candidate whose schema the previous runtime cannot be assumed to read. */
  const rehearsed = async () => {
    await phases.prepare({ packageSha256: createHash('sha256').update('packed candidate').digest('hex') });
    const r = journal();
    durableJson(journalFile, { ...r, phase: 'rehearsed', rehearsal: { integrity: 'ok', previousRuntimeCompatible: false } });
    log.length = 0; lastPhase = '';
  };
  return {
    root, database, stage, plist, livePlist, nextDist, codingBackup, log, journals, hooks, current, services, phases, journal, orders, gateOwned, rehearsed, appearCatalog,
    reset: () => { log.length = 0; lastPhase = ''; for (const key of Object.keys(journals)) delete journals[key]; },
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
const tamper = (file: string) => writeFileSync(file, 'changed after it was verified');
const quietly = <T>(run: () => T) => { const spy = vi.spyOn(console, 'error').mockImplementation(() => {}); try { return run(); } finally { spy.mockRestore(); } };

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
    expect(d.log.slice(recovering)).toEqual(['bootout', 'bootstrap previous while paused', 'healthz while paused']);
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
