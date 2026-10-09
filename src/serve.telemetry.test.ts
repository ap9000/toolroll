import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openStore } from './store.js';
import { createDecisionServer } from './serve.js';
import { mintApiToken } from './api-tokens.js';
import { setLimitOverride } from './request-budget.js';
import { main } from './cli.js';

test('real HTTP requests, live streams and budget refusals reach metrics and the connected health command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'so-server-telemetry-')), store = openStore(join(dir, 'orders.db'));
  const now = new Date(); store.saveApprover('synthetic-operator', 'not-a-login', now);
  const mint = (account: string) => {
    const value = mintApiToken(); store.createApiToken({ id: value.id, account, name: 'synthetic-token', secretHash: value.hash, access: 'read', expiresAt: new Date(Date.now() + 60_000).toISOString(), by: account }, now); return value.token;
  };
  const token = mint('synthetic-operator'), headers = { authorization: `Bearer ${token}` };
  setLimitOverride(store, '*', { readPerMinute: 1, actPerMinute: null, perDay: null }, 'synthetic-operator', now);
  const server = createDecisionServer({ store, evidenceRoot: dir, configDir: dir, repo: dir, toolHome: dir, connectionHome: dir, chatEnv: {} });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('listen');
  const url = `http://127.0.0.1:${address.port}`, streamAbort = new AbortController();
  let drain: Promise<void> | undefined;
  try {
    expect((await fetch(`${url}/health`, { redirect: 'manual' })).status).not.toBe(200);
    const first = await fetch(`${url}/api/cli`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ argv: ['task', 'list', '--json'] }) });
    expect(first.status).toBe(200); expect((await first.json()).exitCode).toBe(0);
    expect((await fetch(`${url}/api/cli`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' })).status).toBe(429);
    // Budgets cover every remote route (0.9.49): lift the tiny limit so the stream, metrics and health calls below are admitted.
    setLimitOverride(store, '*', { readPerMinute: null, actPerMinute: null, perDay: null }, 'synthetic-operator', now);
    const stream = await fetch(`${url}/live?room=${encodeURIComponent('team?conversation=')}`, { headers, signal: streamAbort.signal });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader(); await reader.read();
    drain = (async () => { try { while (!(await reader.read()).done) {} } catch { /* own abort */ } finally { reader.releaseLock(); } })();
    expect(store.telemetry.snapshot().streams.open).toBe(1);
    expect(store.telemetry.routes.get('live')!.total.count).toBe(1);
    const text = await (await fetch(`${url}/metrics`, { headers })).text();
    expect(text).toContain('toolroll_http_request_duration_seconds_count{route="cli"} 2');
    expect(text).toContain('toolroll_request_budget_refusals_total{route="api",reason="read-per-minute"} 1');
    expect(text).toContain('toolroll_sse_connections{route="live"} 1');
    expect(text).not.toContain('conversation='); expect(text).not.toContain('room='); expect(text).not.toContain(token);
    const profileFile = join(dir, 'profile.json');
    writeFileSync(profileFile, JSON.stringify({ version: 1, active: 'test', profiles: { test: { origin: url, account: 'synthetic-operator', token } } }), { mode: 0o600 });
    const lines: string[] = [];
    expect(await main(['health'], line => lines.push(line), { team: { profileFile } })).toBe(0);
    expect(lines.join('\n')).toContain('SQLite write-lock waits:'); expect(lines.join('\n')).toContain('Live streams: 1 open');
    lines.length = 0;
    expect(await main(['health', '--json'], line => lines.push(line), { team: { profileFile } })).toBe(0);
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: true, command: 'health', health: { version: 1, streams: { open: 1 }, budgetRefusals: 1 } });
    store.saveApprover('synthetic-project-reader', 'not-a-login', now);
    store.setAccountProjects('synthetic-project-reader', [dir], 'synthetic-operator', now);
    expect((await fetch(`${url}/health`, { headers: { authorization: `Bearer ${mint('synthetic-project-reader')}` }, redirect: 'manual' })).status).toBe(403);
    streamAbort.abort(); await drain;
    await new Promise<void>(resolve => setImmediate(resolve));
  } finally {
    streamAbort.abort(); await drain;
    await new Promise<void>(resolve => server.close(() => resolve()));
    expect(store.telemetry.snapshot().streams.open).toBe(0);
    store.close(); rmSync(dir, { recursive: true, force: true });
  }
});
