import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from './store.js';
import { TeamLeads } from './team-leads.js';
import { addApprover } from './scope.js';
import { prepareWorkspaceRevision, statementEffect, WorkspaceValidatorCache, type WorkspaceRevision } from './workspace-revision.js';

const NOW = new Date('2026-09-21T12:00:00.000Z');
const at = (ms: number): string => new Date(NOW.getTime() + ms).toISOString();
let store: Store, revision: WorkspaceRevision, directory: string, file: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'so-workspace-revision-')); file = join(directory, 'orders.db');
  store = openStore(file); revision = prepareWorkspaceRevision(store);
});
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });

function task() { store.createTask({ id: 'task', title: 'Original title' }, NOW); return store.lookupRef('task')!.id; }
function runner(heartbeat = at(0)) {
  store.raw().prepare(`INSERT INTO runner(name,host,credential_hash,capacity,registered_at,heartbeat_at) VALUES ('worker','host','hash',1,?,?)`).run(at(0), heartbeat);
}

test('conditional response metadata retains 256 keys and evicts in insertion order without refreshing reads', () => {
  const cache = new WorkspaceValidatorCache();
  const validators = Array.from({ length: 257 }, (_, index) => ({
    etag: `"tag-${index}"`, revision: `v1:${index}`, expiresAt: NOW.getTime() + index,
  }));
  expect(cache.get('missing')).toBeUndefined();
  for (let index = 0; index < 256; index++) cache.set(String(index), validators[index]!);
  // A read of the oldest key does not promote it or extend its deadline.
  expect(cache.get('0')).toBe(validators[0]);
  expect(cache.get('255')).toBe(validators[255]);
  cache.set('256', validators[256]!);
  expect(cache.get('0')).toBeUndefined();
  for (let index = 1; index <= 256; index++) expect(cache.get(String(index))).toBe(validators[index]);
  // Preserve the server's existing write-at-capacity semantics for repeated keys.
  cache.set('256', validators[0]!);
  expect(cache.get('1')).toBeUndefined();
  expect(cache.get('2')).toBe(validators[2]);
  expect(cache.get('256')).toBe(validators[0]);
});

test('source writes, another process\'s writes and deletes invalidate once per commit; rolled-back writes do not', () => {
  const initial = revision.current(); task();
  expect(revision.current()).not.toBe(initial);
  const written = revision.current();
  // Another Toolroll process: its own wrapped connection. Its commit reaches this one through data_version.
  const other = openStore(file);
  try {
    expect(() => other.transact(() => { other.raw().exec("UPDATE task SET title='Rolled back'"); throw new Error('no'); })).toThrow('no');
    other.raw().exec("BEGIN; UPDATE task SET title='Also rolled back'; ROLLBACK;");
    expect(revision.current()).toBe(written);
    other.raw().exec("UPDATE task SET title='Changed by another writer'"); expect(revision.current()).toBe(`v1:${Number(written.slice(3)) + 1}`);
    const changed = revision.current();
    other.transact(() => { other.raw().exec("UPDATE task SET title='One'"); other.raw().exec("UPDATE task SET title='Two'"); });
    expect(revision.current()).toBe(`v1:${Number(changed.slice(3)) + 1}`);
    const twice = revision.current();
    other.raw().exec("DELETE FROM task WHERE id='task'"); expect(revision.current()).not.toBe(twice);
    // A write that changes no row moves nothing.
    const after = revision.current();
    other.raw().exec("UPDATE task SET title='Nobody' WHERE id='absent'"); expect(revision.current()).toBe(after);
  } finally { other.close(); }
});

test('a savepoint rolled back to takes its writes with it; the outer commit moves the revision once', () => {
  const ref = task(); const before = revision.current();
  store.transact(() => {
    expect(() => store.savepoint(() => { store.raw().exec("UPDATE task SET title='Undone'"); throw new Error('undo'); })).toThrow('undo');
    store.raw().prepare('SELECT 1').get();
  });
  expect(revision.current()).toBe(before);
  store.transact(() => store.savepoint(() => store.raw().prepare('UPDATE task_ref SET repo = ? WHERE id = ?').run('/repo', ref)));
  expect(revision.current()).toBe(`v1:${Number(before.slice(3)) + 1}`);
  // A savepoint outside any transaction commits when it is released.
  const inside = revision.current();
  store.savepoint(() => store.raw().exec("UPDATE task SET title='Released'"));
  expect(revision.current()).toBe(`v1:${Number(inside.slice(3)) + 1}`);
});

test('the revision survives closing every process; preparing installs no trigger', () => {
  task(); const before = revision.current();
  const triggers = () => Number(store.raw().prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='trigger' AND name LIKE 'workspace_revision_%'").get()!['n']);
  expect(triggers()).toBe(0);
  expect(prepareWorkspaceRevision(store).current()).toBe(before);
  store.close();
  const writer = openStore(file);
  writer.raw().exec("UPDATE task SET title='Changed while browser was stopped'"); writer.close();
  store = openStore(file); revision = prepareWorkspaceRevision(store);
  expect(revision.current()).not.toBe(before); expect(triggers()).toBe(0);
});

test('the statement reader names quiet columns, omitted tables and transaction boundaries', () => {
  expect(statementEffect('UPDATE runner SET heartbeat_at = ? WHERE name = ?')).toEqual({ kind: 'write', table: 'runner', quiet: true });
  expect(statementEffect('UPDATE claim SET heartbeat_at = ?, expires_at = ?\n WHERE lease_id = ?')).toEqual({ kind: 'write', table: 'claim', quiet: true });
  expect(statementEffect('UPDATE runner SET capacity = 2, heartbeat_at = ?')).toEqual({ kind: 'write', table: 'runner', quiet: false });
  expect(statementEffect('UPDATE "watch_episode" SET ticks = ticks + 1')).toEqual({ kind: 'write', table: 'watch_episode', quiet: true });
  expect(statementEffect('INSERT INTO provider_readiness (runner) VALUES (?) ON CONFLICT DO UPDATE SET observed_at = 1')).toMatchObject({ quiet: false });
  expect(statementEffect('-- note\nINSERT OR IGNORE INTO service_cursor(key) VALUES (?)')).toEqual({ kind: 'none' });
  expect(statementEffect('DELETE FROM main.task WHERE id = ?')).toEqual({ kind: 'write', table: 'task', quiet: false });
  expect(statementEffect('WITH x AS (SELECT 1) UPDATE task SET title = ?')).toEqual({ kind: 'write', table: 'task', quiet: false });
  expect(statementEffect('CREATE TEMP TRIGGER t AFTER UPDATE ON main.task BEGIN SELECT 1; END')).toEqual({ kind: 'none' });
  expect(statementEffect('SELECT * FROM task')).toEqual({ kind: 'none' });
  expect(statementEffect('BEGIN IMMEDIATE')).toEqual({ kind: 'begin' });
  expect(statementEffect('ROLLBACK TO sp_1')).toEqual({ kind: 'rollback-to', name: 'sp_1' });
  expect(statementEffect('RELEASE sp_1')).toEqual({ kind: 'release', name: 'sp_1' });
});

test('cursor, wake and ordinary heartbeats stay quiet; real runner changes and revival invalidate', () => {
  runner(at(-160_000)); const before = revision.current();
  expect(revision.expiresAt(NOW)).toBe(NOW.getTime() + 20_000);
  expect(revision.expiresAt(new Date(at(20_000)))).toBe(NOW.getTime() + 20_000);
  store.setServiceCursor('other-maintenance', 4, NOW);
  store.raw().exec('UPDATE wake SET seq=seq+1');
  store.raw().prepare("INSERT INTO telegram_retry(bot_id,next_attempt_at) VALUES ('bot',?)").run(at(5_000));
  store.raw().prepare('UPDATE telegram_retry SET next_attempt_at=?').run(at(10_000));
  store.raw().exec('DELETE FROM telegram_retry');
  store.raw().prepare("UPDATE runner SET heartbeat_at=?").run(at(-150_000));
  expect(revision.current()).toBe(before);
  expect(revision.expiresAt(NOW)).toBe(NOW.getTime() + 30_000);
  // Keep the original response's deadline: renewing a beat never extends a
  // representation already cached by the HTTP layer.
  store.raw().exec('UPDATE runner SET capacity=2');
  expect(revision.current()).not.toBe(before);
  const changed = revision.current();
  store.raw().prepare('UPDATE runner SET heartbeat_at=?').run(at(40_000));
  expect(revision.current()).not.toBe(changed);
});

test('claim renewals are quiet but release invalidates and lease/hold boundaries expire the view', () => {
  const ref = task();
  store.raw().prepare(`INSERT INTO claim(lease_id,task_ref,lease_generation,runner,acquired_at,expires_at,heartbeat_at) VALUES ('lease',?,1,'worker',?,?,?)`).run(ref, at(0), at(12_000), at(0));
  const before = revision.current();
  expect(revision.expiresAt(NOW)).toBe(NOW.getTime() + 12_000);
  store.raw().prepare('UPDATE claim SET heartbeat_at=?,expires_at=?').run(at(1_000), at(30_000));
  expect(revision.current()).toBe(before);
  store.hold(ref, 'Wait', new Date(at(15_000)), NOW);
  expect(revision.expiresAt(NOW)).toBe(NOW.getTime() + 15_000);
  const held = revision.current();
  store.raw().prepare('UPDATE claim SET released_at=?').run(at(2_000));
  expect(revision.current()).not.toBe(held);
  expect(revision.expiresAt(new Date(at(15_000)))).toBe(NOW.getTime() + 75_000);
});

test('mode and provider boundaries cap freshness and the fallback never exceeds sixty seconds', () => {
  expect(revision.expiresAt(NOW)).toBe(NOW.getTime() + 60_000);
  expect(addApprover(store, 'owner', NOW).ok).toBe(true);
  store.raw().prepare(`INSERT INTO operating_mode(repo,name,terms_json,digest,signed_by,signed_at,absolute_expiry) VALUES ('/repo','standard','{}','digest','owner',?,?)`).run(at(0), at(25_000));
  expect(revision.expiresAt(NOW)).toBe(NOW.getTime() + 25_000);
  store.raw().prepare(`INSERT INTO capability(repo,kind,name,added_by,created_at,expires_at) VALUES ('/repo','cli','codex','owner',?,?)`).run(at(0), at(9_000));
  expect(revision.expiresAt(NOW)).toBe(NOW.getTime() + 9_000);
  store.raw().prepare(`INSERT INTO quota(runner,provider,state,reason,observed_at,reset_at) VALUES ('worker','codex','exhausted','limit',?,?)`).run(at(0), at(5_000));
  expect(revision.expiresAt(NOW)).toBe(NOW.getTime() + 5_000);
});

test('provider observation renewals and watch tick/lease renewal are quiet but changed facts invalidate', () => {
  runner();
  store.recordProviderReadiness('worker', [{ provider: 'codex', state: 'ready', reason: 'ready', probe: 'identity' }], NOW);
  const before = revision.current();
  store.recordProviderReadiness('worker', [{ provider: 'codex', state: 'ready', reason: 'ready', probe: 'identity' }], new Date(at(1_000)));
  expect(revision.current()).toBe(before);
  store.recordProviderReadiness('worker', [{ provider: 'codex', state: 'unavailable', reason: 'signed out', probe: 'identity' }], new Date(at(2_000)));
  expect(revision.current()).not.toBe(before);
  store.raw().prepare(`INSERT INTO watch_lease(runner,repo,owner,generation,started_at,expires_at,heartbeat_at) VALUES ('worker','/repo','owner',1,?,?,?)`).run(at(0), at(20_000), at(0));
  store.raw().prepare(`INSERT INTO watch_episode(repo,runner,incarnation,started_at) VALUES ('/repo','worker','incarnation',?)`).run(at(0));
  const watch = revision.current();
  store.raw().exec('UPDATE watch_episode SET ticks=ticks+1');
  store.raw().prepare('UPDATE watch_lease SET heartbeat_at=?,expires_at=?').run(at(1_000), at(30_000));
  expect(revision.current()).toBe(watch);
  expect(revision.expiresAt(NOW)).toBe(NOW.getTime() + 30_000);
  store.raw().exec('UPDATE watch_episode SET built=built+1');
  expect(revision.current()).not.toBe(watch);
});


test('personal shared-chat reading and saved request receipts do not invalidate everyone’s workspace',()=>{
  store.saveApprover('alex','hash-alex',NOW);const actor={name:'alex',generation:1},domain=new TeamLeads(store,()=>['/repo']);
  const leadId=(domain.execute(actor,{operation:'create-lead',args:{name:'Lead',projects:['/repo']}},NOW).result as {leadId:string}).leadId;
  const conversationId=(domain.execute(actor,{operation:'create-conversation',args:{leadId,title:'Room',visibility:'team',projects:['/repo']}},NOW).result as {conversationId:string}).conversationId;
  const sent=domain.execute(actor,{operation:'send',args:{conversationId,text:'Saved request',requestId:'send'}},NOW);const messageId=(sent.result as {messageId:number}).messageId;
  const before=revision.current();
  const read=domain.execute(actor,{operation:'read',args:{conversationId,messageId,requestId:'read-receipt'}},NOW);
  expect(read.ok).toBe(true);expect(read.snapshot).toBeUndefined();expect(revision.current()).toBe(before);
});
