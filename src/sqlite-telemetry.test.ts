import { expect, test } from 'vitest';
import { instrumentDatabase, measureWriteWait } from './sqlite-telemetry.js';
import { ServerTelemetry } from './server-telemetry.js';
import type { Database } from './store.js';
import { openStore } from './store.js';
import type { DatabaseSync } from 'node:sqlite';

test('instrumentation preserves native scalar functions and statement configuration used by real queries', () => {
  const store = openStore(':memory:');
  try {
    const db = store.handle as unknown as DatabaseSync;
    db.function('telemetry_fixture', { deterministic: true }, () => 42n);
    const statement = db.prepare('SELECT telemetry_fixture() AS n');
    statement.setReadBigInts(true);
    expect(statement.get()?.n).toBe(42n);
  } finally { store.close(); }
});

test('write retry slices are one wait, hold starts after acquisition, failure and rollback retain timings', () => {
  let now = 0, attempts = 0;
  const telemetry = new ServerTelemetry(() => now);
  const native = {
    exec(sql: string) {
      if (sql === 'BEGIN IMMEDIATE') { now += 100; if (++attempts < 3) throw Error('busy'); }
      if (sql === 'COMMIT' || sql === 'ROLLBACK') now += 5;
    }, prepare() { throw Error('unused'); }, close() {},
  } satisfies Database;
  const db = instrumentDatabase(native, telemetry);
  measureWriteWait(db, () => { for (let i = 0; i < 3; i++) { try { db.exec('BEGIN IMMEDIATE'); return; } catch { /* simulated native busy slice */ } } });
  now += 2000; db.exec('ROLLBACK');
  expect(telemetry.writeWait.total).toMatchObject({ count: 1, sum: 0.3 });
  expect(telemetry.writeHold.total).toMatchObject({ count: 1, sum: 2.005 });
  expect(() => measureWriteWait(db, () => { now += 15_000; throw Error('busy timeout'); })).toThrow('busy timeout');
  expect(telemetry.writeWait.total).toMatchObject({ count: 2, sum: 15.3 });
  expect(telemetry.writeHold.total.count).toBe(1);
  db.exec('BEGIN IMMEDIATE'); now += 30; db.exec('COMMIT');
  expect(telemetry.writeWait.total.count).toBe(3);
  expect(telemetry.writeHold.total.count).toBe(2);
});

test('standalone native write duration includes a busy error; reads and nested writes do not add hold observations', () => {
  let now = 0; const telemetry = new ServerTelemetry(() => now);
  const native: Database = {
    exec() {}, close() {},
    prepare: () => ({ run() { now += 15_000; throw Error('busy'); }, get() { now += 2; return undefined; }, all() { return []; } }),
  };
  const db = instrumentDatabase(native, telemetry);
  db.prepare('SELECT 1').get();
  expect(() => db.prepare('-- test\nUPDATE task SET title = ?').run('private')).toThrow('busy');
  expect(telemetry.writeStatement.total).toMatchObject({ count: 1, sum: 15 });
  db.exec('BEGIN IMMEDIATE'); db.prepare('INSERT INTO task VALUES (?) RETURNING id').get('value'); db.exec('COMMIT');
  expect(telemetry.writeStatement.total.count).toBe(1);
  expect(telemetry.writeHold.total).toMatchObject({ count: 1, sum: 0.002 });
});
