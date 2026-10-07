import { workerData, parentPort } from 'node:worker_threads';
import { readFileSync, realpathSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
const { scratch, nonce, runs, rate, seconds } = workerData;
const evidence = realpathSync(fileURLToPath(new URL('../../evidence', import.meta.url)));
if (realpathSync(scratch) !== scratch || dirname(scratch) !== evidence || !basename(scratch).startsWith('.bench-team-') || JSON.parse(readFileSync(join(scratch, 'bench-owner.json'), 'utf8')).nonce !== nonce) throw Error('Refusing a non-benchmark database.');
const db = new DatabaseSync(join(scratch, 'orders.db'));
db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 15000;');
const update = db.prepare(`INSERT INTO run_check(run,snapshot,line,final,updated_at) VALUES(?,?,?,0,?)
  ON CONFLICT(run) DO UPDATE SET snapshot=excluded.snapshot,line=excluded.line,updated_at=excluded.updated_at`);
parentPort.postMessage({ kind: 'ready' });
await new Promise(resolve => parentPort.once('message', resolve));
const start = performance.now(), end = start + seconds * 1000, interval = 1000 / rate;
const wait = [], hold = []; let written = 0, failed = 0, missed = 0;
try {
  for (let tick = 0; start + tick * interval < end; tick++) {
    for (const [i, run] of runs.entries()) {
      const due = start + tick * interval + i * interval / runs.length;
      if (due >= end) break;
      const pause = due - performance.now(); if (pause > 0) await delay(pause);
      if (performance.now() - due > interval) { missed++; continue; }
      const suites = { unit: { state: 'running', passed: tick, failed: 0, skipped: 0, total: null }, flows: { state: 'pending', passed: 0, failed: 0, skipped: 0, total: null }, app: { state: 'pending', passed: 0, failed: 0, skipped: 0, total: null } };
      const line = `unit ${tick} · flows … · app …`, snapshot = JSON.stringify({ version: 1, final: false, line, suites });
      const before = performance.now(); let acquired;
      try {
        db.exec('BEGIN IMMEDIATE'); acquired = performance.now(); wait.push(acquired - before);
        update.run(run, snapshot, line, new Date().toISOString()); db.exec('COMMIT'); written++;
      } catch {
        failed++; if (acquired === undefined) wait.push(performance.now() - before);
        else db.exec('ROLLBACK');
      } finally { if (acquired !== undefined) hold.push(performance.now() - acquired); }
    }
  }
} finally { db.close(); }
parentPort.postMessage({ kind: 'done', wait, hold, written, failed, missed }); parentPort.close();
