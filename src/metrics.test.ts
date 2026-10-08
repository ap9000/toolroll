import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { expect, test } from 'vitest';
import { performanceMetrics, prometheusMetrics } from './metrics.js';
import { ServerTelemetry, TimingHistogram, routeFamily, healthWords, ROUTE_FAMILIES } from './server-telemetry.js';
import { openStore } from './store.js';

test('performance metric names, types and bounded labels contain no request paths or identities', () => {
  const telemetry = new ServerTelemetry(() => 0);
  for (const path of ['/api/cli?token=private-secret', '/t/private-person-id/complete', '/r/987654/evidence/123', '/unrecognised-private-person', '/flows/456/live', '/api/team/events?conversation=secret']) {
    telemetry.observeRequest(routeFamily(path), 12);
  }
  telemetry.writeWait.observe(15); telemetry.writeHold.observe(2); telemetry.writeStatement.observe(0.3);
  telemetry.eventLoop.observe(0.02); telemetry.budgetRefused('api', 'read-per-minute');
  const text = performanceMetrics(telemetry);
  for (const name of ['http_request_duration', 'sqlite_write_wait', 'sqlite_write_hold', 'sqlite_write_statement']) {
    expect(text).toContain(`# TYPE toolroll_${name}_seconds histogram`);
    expect(text).toContain(`toolroll_${name}_seconds_count`);
    expect(text).toContain(`toolroll_${name}_seconds_sum`);
  }
  expect(text).toContain('toolroll_http_request_duration_seconds_bucket{route="tasks",le="0.015"} 1');
  expect(text).toContain('toolroll_event_loop_delay_seconds{quantile="0.99"} 0.02');
  expect(text).toContain('toolroll_request_budget_refusals_total{route="api",reason="read-per-minute"} 1');
  expect(text).not.toMatch(/private|secret|987654|456|conversation|token=/);
  const labels = [...text.matchAll(/(?:route|reason|quantile|le)="([^"\n]*)"/g)].map(match => match[1]);
  expect(labels.every(value => !value?.includes('/'))).toBe(true);
  expect(new Set([...text.matchAll(/route="([^"]+)"/g)].map(match => match[1]))).toEqual(new Set([...ROUTE_FAMILIES, 'api']));
});

test('per-stream queue distribution keeps no stream ID and cleans up on finish and disconnect', () => {
  const telemetry = new ServerTelemetry(() => 0);
  const slow = Object.assign(new EventEmitter(), { writableLength: 8192, writableEnded: false, destroyed: false }) as unknown as ServerResponse;
  const quick = Object.assign(new EventEmitter(), { writableLength: 0, writableEnded: false, destroyed: false }) as unknown as ServerResponse;
  telemetry.openStream(slow, 'team-stream'); telemetry.openStream(quick, 'team-stream');
  expect(telemetry.snapshot().streams).toEqual({ open: 2, queuedBytes: 8192, maxQueuedBytes: 8192 });
  expect(performanceMetrics(telemetry)).toContain('toolroll_sse_queue_bytes_bucket{route="team-stream",le="0"} 1');
  expect(performanceMetrics(telemetry)).toContain('toolroll_sse_queue_bytes_bucket{route="team-stream",le="16384"} 2');
  slow.emit('close'); slow.emit('finish'); quick.emit('finish');
  expect(telemetry.snapshot().streams.open).toBe(0);
});

test('recent measurements expire without resetting cumulative histograms; idle health never invents samples', () => {
  let now = 0; const telemetry = new ServerTelemetry(() => now), histogram = new TimingHistogram(() => now);
  histogram.observe(0.012); telemetry.observeRequest('cli', 12); telemetry.budgetRefused('mcp', 'per-day');
  expect(histogram.recent()).toMatchObject({ count: 1, p50Ms: 12, p99Ms: 12 });
  now = 300_000;
  expect(histogram.recent()).toMatchObject({ count: 0, p50Ms: null, p99Ms: null });
  expect(histogram.total.count).toBe(1);
  expect(telemetry.snapshot().budgetRefusals).toBe(0);
  expect(healthWords(telemetry.snapshot())).toContain('Requests: no samples yet.');
  expect(healthWords(telemetry.snapshot())).toContain('Live streams: 0 open');
});

test('the existing exporter includes real Store transaction and standalone write timings', () => {
  const store = openStore(':memory:');
  try {
    store.transact(() => { store.createTask({ id: 'synthetic', title: 'Synthetic telemetry test' }, new Date()); });
    const before = store.telemetry.writeHold.total.count;
    expect(() => store.transact(() => { throw Error('rollback'); })).toThrow('rollback');
    expect(store.telemetry.writeHold.total.count).toBe(before + 1);
    store.handle.prepare('UPDATE task SET title = ? WHERE id = ?').run('Changed synthetic title', 'synthetic');
    expect(store.telemetry.writeStatement.total.count).toBeGreaterThan(0);
    const exported = prometheusMetrics(store, new Date());
    expect(exported).toContain('toolroll_sqlite_write_wait_seconds_count');
    expect(exported).toContain('toolroll_sse_connections{route="team-stream"} 0');
  } finally { store.close(); }
});

test('event-loop samples have the 20 ms sampling interval subtracted, so an idle loop reads zero', () => {
  // A stand-in for the native delay monitor: raw samples in milliseconds, read back as nanosecond percentiles.
  let raw = [20, 20, 21, 30], resets = 0;
  const monitor = {
    get count() { return raw.length; },
    percentile: (p: number) => raw[Math.max(0, Math.ceil(p / 100 * raw.length) - 1)]! * 1e6,
    reset: () => { raw = []; resets++; },
  };
  const telemetry = new ServerTelemetry(() => 0);
  Object.assign(telemetry, { monitor });
  telemetry.sampleEventLoop();
  expect(resets).toBe(1);
  expect(telemetry.eventLoop.recent()).toEqual({ count: 4, p50Ms: 0.1, p99Ms: 10, maxMs: 10, totalMs: 11 });
  telemetry.sampleEventLoop(); // nothing new since the reset adds nothing
  expect(telemetry.eventLoop.total.count).toBe(4);

  const idle = new ServerTelemetry(() => 0);
  raw = [20, 20, 20];
  Object.assign(idle, { monitor });
  expect(idle.snapshot().eventLoop).toEqual({ count: 3, p50Ms: 0, p99Ms: 0, maxMs: 0, totalMs: 0 });
});
