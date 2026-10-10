import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { recoverFailedDeployment, recoverOnExit, waitUntilHealthy } from '../scripts/deploy-recovery.mjs';
import { codingBackupBeforeSwap, restoreDeploymentBackup, stopProved } from '../scripts/deploy-phases.mjs';
import { fakePid } from '../test/fake-pid.js';

/** The effects a failed browser deployment may take, recorded in order. */
function effects(stopProved = false, gateHeld = true) {
  const done: string[] = [];
  return {
    done,
    stopProved: () => { done.push('prove stop'); return stopProved; },
    restoreBackup: () => { done.push('restore backup'); return '/stage/orders.kept.1.db'; },
    restoreService: () => { done.push('restore service'); },
    removeGate: () => { done.push(gateHeld ? 'remove gate' : 'no gate held'); return gateHeld; },
    mark: (phase: string) => { done.push(`mark ${phase}`); },
  };
}

test('a deploy that fails after proving the old service stopped starts it again and lifts its own pause', () => {
  // Oct 2: two deploys over 0.9.11 failed after the bootout and left the plane down until restored by hand.
  const e = effects();
  expect(recoverFailedDeployment('stopped', e)).toMatch(/previous service is running again and new work resumed\.$/);
  expect(e.done).toEqual(['restore service', 'mark restored', 'remove gate', 'mark released']);
  // The previous service is already running again: only the pause is left to lift.
  const restored = effects();
  expect(recoverFailedDeployment('restored', restored)).toMatch(/new work resumed/);
  expect(restored.done).toEqual(['remove gate', 'mark released']);
});

test('once the live database was migrated, the verified backup goes back before the previous service starts', () => {
  for (const phase of ['migrating', 'migrated', 'start-failed']) {
    const e = effects();
    expect(recoverFailedDeployment(phase, e)).toMatch(/put back from the backup taken before the update; what the live database held is kept at \/stage\/orders\.kept\.1\.db/);
    expect(e.done).toEqual(['restore backup', 'mark backup-restored', 'restore service', 'mark restored', 'remove gate', 'mark released']);
  }
  // A same-schema candidate whose rehearsal proved the previous runtime reads its database keeps it.
  const compatible = effects();
  expect(recoverFailedDeployment('migrated', compatible, { previousRuntimeCompatible: true })).not.toMatch(/backup/);
  expect(compatible.done).toEqual(['restore service', 'mark restored', 'remove gate', 'mark released']);
  // Resumed after the backup went back but before the service answered: the backup is not put back twice.
  const resumed = effects();
  recoverFailedDeployment('backup-restored', resumed);
  expect(resumed.done).toEqual(['restore service', 'mark restored', 'remove gate', 'mark released']);
});

test('a backup that cannot go back leaves the service stopped and the pause in place', () => {
  const e = { ...effects(), restoreBackup: () => { throw Error('the verified backup is missing or changed'); } };
  expect(() => recoverFailedDeployment('migrated', e)).toThrow('missing or changed');
  expect(e.done).toEqual([]);
});

test('a previous service that does not load or answer keeps the pause and says so', () => {
  const e = { ...effects(), restoreService: () => { throw Error('did not answer /healthz within 90 seconds'); } };
  expect(() => recoverFailedDeployment('stopped', e)).toThrow('/healthz');
  expect(e.done).toEqual([]);
});

test('a refusal before the swap only lifts the pause; an unproven stop or a starting service is left for a person', () => {
  for (const phase of ['admission-paused', 'frozen', 'backup-verified', 'rehearsed']) {
    const e = effects();
    expect(recoverFailedDeployment(phase, e)).toMatch(/stopped before the swap/);
    expect(e.done).toEqual(['remove gate', 'mark released']);
  }
  for (const phase of ['starting', 'started', 'healthy', 'deployed', 'released']) {
    const e = effects();
    expect(recoverFailedDeployment(phase, e)).toBeNull();
    expect(e.done).toEqual([]);
  }
  const unproven = effects(false);
  expect(recoverFailedDeployment('stopping', unproven)).toBeNull();
  expect(unproven.done).toEqual(['prove stop']);
  // Interrupted while waiting for the old service to exit, after it had: it is put back like any stopped service.
  const proven = effects(true);
  expect(recoverFailedDeployment('stopping', proven)).toMatch(/running again/);
  expect(proven.done).toEqual(['prove stop', 'restore service', 'mark restored', 'remove gate', 'mark released']);
});

test('a deploy that fails while preparing lifts only a pause it holds, and otherwise stays resumable', () => {
  // Journaled before the pause was installed: a failure between the two still knows the pause's owner.
  const held = effects();
  expect(recoverFailedDeployment('preparing', held)).toMatch(/before the swap, and lifted its pause/);
  expect(held.done).toEqual(['remove gate', 'mark released']);
  // No pause of its own (never installed, or another update's): nothing is undone and the journal is not marked.
  const none = effects(false, false);
  expect(recoverFailedDeployment('preparing', none)).toBeNull();
  expect(none.done).toEqual(['no gate held']);
});

test('the restored service counts only once it answers', () => {
  const answers = [false, false, true];
  let pauses = 0;
  expect(waitUntilHealthy(() => answers.shift()!, { attempts: 5, pause: () => { pauses++; } })).toBe(true);
  expect(pauses).toBe(2);
  pauses = 0;
  expect(waitUntilHealthy(() => false, { attempts: 3, pause: () => { pauses++; } })).toBe(false);
  expect(pauses).toBe(2);
});

test('Ctrl-C or a kill runs the same exit recovery, and a second signal waits for it', () => {
  const module = fileURLToPath(new URL('../scripts/deploy-recovery.mjs', import.meta.url));
  // The child recovers synchronously at exit, as deploy-browser does; it signals itself twice while waiting.
  const child = `
    const { exitOnSignals, sleepSync } = await import(${JSON.stringify(module)});
    exitOnSignals();
    process.on('exit', code => {
      process.kill(process.pid, 'SIGINT');
      sleepSync(50);
      process.stdout.write('recovered at exit ' + code);
    });
    process.kill(process.pid, process.argv[1]);
    setInterval(() => {}, 1000);`;
  for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]] as const) {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', child, signal], { encoding: 'utf8', timeout: 10_000 });
    expect(run.stdout).toBe(`recovered at exit ${code}`);
    expect(run.status).toBe(code);
  }
});

test('a deployment that exits in failure, or on a signal, recovers on its way out', () => {
  const proc = Object.assign(new EventEmitter(), { exit: (code: number) => { proc.emit('exit', code); } });
  let recovered = 0;
  recoverOnExit(() => { recovered++; }, proc);
  proc.emit('exit', 0);
  expect(recovered).toBe(0);
  proc.emit('exit', 1);
  expect(recovered).toBe(1);
  proc.emit('SIGTERM');
  expect(recovered).toBe(2);
});

/** deploy-browser's backup restore for a scratch database and stage. */
const backupRestore = (stageDir: string, database: string) => (r: object) => restoreDeploymentBackup(r, { database, stageDir }) as string;

test('a migrated database is replaced by the verified backup, and what it held is kept aside', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-restore-')), database = join(dir, 'orders.db'), backupFile = join(dir, 'orders.backup.db');
  try {
    const before = new DatabaseSync(backupFile);
    before.exec("CREATE TABLE schema_version(version INTEGER); INSERT INTO schema_version VALUES(7); CREATE TABLE action_ledger(at,actor,repo,task_id,run_id,action,outcome,source,detail)");
    before.close();
    copyFileSync(backupFile, database);
    // The candidate migrated the live database and it still holds an uncheckpointed write.
    const live = new DatabaseSync(database);
    live.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE schema_version SET version=8; CREATE TABLE added(x)");
    const restore = backupRestore(dir, database);
    const owner = fakePid(1);
    const r = { backup: backupFile, backupSha256: createHash('sha256').update(readFileSync(backupFile)).digest('hex'), codingOwnerReleased: { pid: owner, nativePid: null }, codingOwnerReleasedAt: '2026-10-02T09:15:00.000Z' };
    expect(() => restore({ ...r, backupSha256: '0'.repeat(64) })).toThrow('missing or changed');
    // A changed backup puts nothing back: the migrated database, its WAL included, is as it was.
    expect(live.prepare('SELECT version FROM schema_version').get()?.version).toBe(8);
    expect(fs.existsSync(`${database}-wal`)).toBe(true);
    live.close();
    const kept = restore(r);
    expect(fs.existsSync(`${database}-wal`)).toBe(false);
    const restored = new DatabaseSync(database, { readOnly: true });
    expect(restored.prepare('SELECT version FROM schema_version').get()?.version).toBe(7);
    // The backup predates the stale-owner release, so the release is ledgered again.
    // Dated when the deployment released it, not when the backup went back.
    expect(restored.prepare('SELECT at, detail FROM action_ledger').get()).toEqual({ at: '2026-10-02T09:15:00.000Z', detail: expect.stringContaining(`process ${owner} proved gone`) });
    restored.close();
    const aside = new DatabaseSync(kept, { readOnly: true });
    expect(aside.prepare('SELECT version FROM schema_version').get()?.version).toBe(8);
    aside.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/** deploy-browser's stop proof, with the processes still running and launchd's answer supplied. */
const stopProof = (running: number[], launchdHasLabel: boolean) => (r: object) =>
  stopProved(r, { alive: (pid: number) => running.includes(pid), loaded: () => launchdHasLabel }) as boolean;

test('a stop is proved from whichever service record the journal holds, never from none', () => {
  // Review of build #2234: a journal with only one record put undefined in the pid set and never proved the stop.
  const oldSupervisor = fakePid(1), oldChild = fakePid(2), stoppingSupervisor = fakePid(3), stoppingChild = fakePid(4);
  const old = { oldService: { supervisor: oldSupervisor, children: [oldChild] } };
  const stopping = { stoppingService: { supervisor: stoppingSupervisor, children: [stoppingChild] } };
  for (const r of [old, stopping, { ...old, ...stopping }]) {
    expect(stopProof([], false)(r)).toBe(true);
    // A recorded process still running, or launchd still holding the label, is not a proved stop.
    expect(stopProof([oldChild, stoppingChild], false)(r)).toBe(false);
    expect(stopProof([], true)(r)).toBe(false);
  }
  expect(stopProof([], false)({})).toBe(false);
  expect(stopProof([], false)({ oldService: { children: [] } })).toBe(false);
  // A recorded pid that is not a real process id still refuses.
  expect(stopProof([], false)({ oldService: { supervisor: 1, children: [] } })).toBe(false);
  expect(stopProof([], false)({ oldService: { supervisor: String(oldSupervisor), children: [] } })).toBe(false);
});

test('the coding database goes back with orders.db, and what it held is kept aside with it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-restore-coding-')), database = join(dir, 'orders.db'), coding = `${database}.coding.sqlite`;
  const backupFile = join(dir, 'orders.backup.db'), codingBackup = join(dir, 'coding.backup.sqlite');
  const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
  const version = (file: string) => { const db = new DatabaseSync(file, { readOnly: true }); try { return db.prepare('SELECT version FROM schema_version').get()?.version; } finally { db.close(); } };
  try {
    for (const file of [backupFile, codingBackup]) {
      const db = new DatabaseSync(file);
      db.exec('CREATE TABLE schema_version(version INTEGER); INSERT INTO schema_version VALUES(3)');
      db.close();
    }
    const migrate = () => {
      copyFileSync(backupFile, database); copyFileSync(codingBackup, coding);
      for (const file of [database, coding]) { const db = new DatabaseSync(file); db.exec('UPDATE schema_version SET version=4'); db.close(); }
    };
    migrate();
    const restore = backupRestore(dir, database);
    const r = { backup: backupFile, backupSha256: sha(backupFile), codingBackupPath: codingBackup, codingBackupHash: sha(codingBackup), codingBackupBeforeSwap: sha(codingBackup) };
    // A changed coding backup puts neither database back.
    expect(() => restore({ ...r, codingBackupBeforeSwap: '0'.repeat(64) })).toThrow('coding backup');
    expect([version(database), version(coding)]).toEqual([4, 4]);
    const kept = restore(r);
    expect([version(database), version(coding)]).toEqual([3, 3]);
    expect([version(kept), version(`${kept}.coding.sqlite`)]).toEqual([4, 4]);
    // A coding database the stopped service never had was the candidate's: it is kept aside, not left in place.
    migrate();
    const fresh = restore({ ...r, codingBackupBeforeSwap: null });
    expect(fs.existsSync(coding)).toBe(false);
    expect(version(`${fresh}.coding.sqlite`)).toBe(4);
    // A journal from before this was recorded and without a coding backup leaves the coding files alone.
    migrate();
    restore({ backup: backupFile, backupSha256: sha(backupFile) });
    expect([version(database), version(coding)]).toEqual([3, 4]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a coding database the stopped service left without a backup is left alone, not deleted', () => {
  // Review of build #2256: no coding backup was recorded as "no coding database", so restore deleted one that existed.
  const dir = mkdtempSync(join(tmpdir(), 'deploy-before-swap-')), database = join(dir, 'orders.db'), coding = `${database}.coding.sqlite`;
  const backupFile = join(dir, 'orders.backup.db');
  const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
  try {
    const db = new DatabaseSync(backupFile);
    db.exec('CREATE TABLE schema_version(version INTEGER); INSERT INTO schema_version VALUES(3)');
    db.close();
    copyFileSync(backupFile, database);
    const beforeSwap = (r: object) => codingBackupBeforeSwap(r, database) as string | null | undefined;
    const restore = backupRestore(dir, database);
    // No coding database before the swap: one found at restore was the candidate's.
    expect(beforeSwap({})).toBeNull();
    expect(beforeSwap({ codingBackupHash: 'a'.repeat(64) })).toBe('a'.repeat(64));
    fs.writeFileSync(coding, 'coding store the stopped service left');
    expect(beforeSwap({})).toBeUndefined();
    const r = { backup: backupFile, backupSha256: sha(backupFile), codingBackupBeforeSwap: beforeSwap({}) };
    const kept = restore(JSON.parse(JSON.stringify(r)));
    expect(readFileSync(coding, 'utf8')).toBe('coding store the stopped service left');
    expect(fs.existsSync(`${kept}.coding.sqlite`)).toBe(false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
