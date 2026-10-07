import { expect, test } from 'vitest';
import { healthSnapshotSchema } from './health.js';
import { ServerTelemetry } from '../server-telemetry.js';

test('health accepts empty and measured snapshots but refuses raw-path labels and nonnumeric measurements', () => {
  const telemetry = new ServerTelemetry(() => 0);
  expect(healthSnapshotSchema.safeParse(telemetry.snapshot()).success).toBe(true);
  telemetry.observeRequest('tasks', 23);
  const snapshot = telemetry.snapshot();
  expect(healthSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  expect(healthSnapshotSchema.safeParse({ ...snapshot, routes: { '/t/private-id': snapshot.requests } }).success).toBe(false);
  expect(healthSnapshotSchema.safeParse({ ...snapshot, eventLoop: { ...snapshot.eventLoop, p99Ms: 'unavailable' } }).success).toBe(false);
  expect(healthSnapshotSchema.safeParse({ ...snapshot, streams: { open: -1, queuedBytes: 0, maxQueuedBytes: 0 } }).success).toBe(false);
});
