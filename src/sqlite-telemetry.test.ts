import { expect, test } from 'vitest';
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
