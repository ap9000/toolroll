import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { request as httpRequest, type Server } from 'node:http';
import { openStore, type Store } from '../store.js';
import { addApprover } from '../scope.js';
import { mintApiToken } from '../api-tokens.js';
import { createDecisionServer } from '../serve.js';
import { setLimitOverride } from '../request-budget.js';
import { ROUTES, matchRoute } from './route-table.js';
import * as cli from '../cli-http.js';
import * as team from '../team-http.js';
import * as sessions from '../session-http.js';
import * as hooks from './remote-hooks.js';

let store: Store, server: Server, port: number, act: string, read: string;
beforeEach(async () => {
  store = openStore(':memory:');
  const now = new Date();
  expect(addApprover(store, 'operator', now).ok).toBe(true);
  const token = (access: 'read' | 'act') => {
    const minted = mintApiToken();
    store.createApiToken({ id: minted.id, account: 'operator', name: access, secretHash: minted.hash, access, expiresAt: new Date(now.getTime() + 86400000).toISOString(), by: 'operator' }, now);
    return minted.token;
  };
  act = token('act'); read = token('read');
  // Admission tests have their own suite. This matrix needs one request per declaration.
  setLimitOverride(store, '*', { readPerMinute: 600, actPerMinute: 600, perDay: 10000 }, 'operator', now);
  server = createDecisionServer({ store, evidenceRoot: '/unused-policy-evidence' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});
afterEach(async () => {
  if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  store.close(); vi.restoreAllMocks();
});
function send(path: string, method = 'GET', token?: string, host?: string): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method, headers: { host: host ?? `127.0.0.1:${port}`, connection: 'close', 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } }, response => {
      let body = '';
      response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, type: String(response.headers['content-type'] ?? ''), body }));
    });
    request.on('error', reject); request.end(method === 'POST' ? '{}' : undefined);
  });
}

test('an act bearer gets 403 at every cookie-only declaration before domain work', async () => {
  const rows = ROUTES.filter(row => row.callers.length === 1 && row.callers[0] === 'cookie');
  expect(rows.length).toBeGreaterThan(50);
  for (const row of rows) expect((await send(row.sample, row.method === 'POST' ? 'POST' : 'GET', act)).status, row.id).toBe(403);
});

test('a read bearer cannot enter any console act or step-up handler, even with a non-form body', async () => {
  const rows = ROUTES.filter(row => row.stage === 'console' && (row.scope === 'act' || row.scope === 'step-up'));
  for (const row of rows) expect((await send(row.sample, 'POST', read)).status, row.id).toBe(403);
});

test('edge unknown paths and wrong methods never invoke a protocol adapter', async () => {
  const spies = [vi.spyOn(cli, 'handleCliHttp'), vi.spyOn(team, 'handleTeamHttp'), vi.spyOn(sessions, 'handleSessionHttp'), vi.spyOn(hooks, 'flowHook'), vi.spyOn(hooks, 'telegramHook')];
  for (const path of ['/oauth/unknown', '/api/cli/unknown', '/api/sessions/unknown', '/api/team/unknown', '/hooks/flow/one/extra', '/hooks/unknown']) {
    for (const method of ['GET', 'POST']) {
      expect(matchRoute(method, path), path).toBeNull();
      expect((await send(path, method, act)).status, `${method} ${path}`).toBe(404);
    }
  }
  for (const [path, method] of [['/api/cli', 'GET'], ['/api/sessions/start', 'GET'], ['/api/team', 'DELETE'], ['/api/team/events', 'POST'], ['/hooks/flow/one', 'GET'], ['/hooks/telegram', 'GET']]) {
    expect((await send(path!, method!, act)).status, `${method} ${path}`).toBe(405);
  }
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  expect(await send('/mcp', 'GET', act)).toMatchObject({ status: 405, type: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'the MCP gateway takes POST only — one JSON-RPC message per request' } }) });
});

test('health and signed hooks retain pre-host exposure; all other edge routes enforce Host first', async () => {
  expect(await send('/healthz', 'GET', undefined, 'foreign.example')).toMatchObject({ status: 200, body: JSON.stringify({ status: 'ok' }) });
  expect((await send('/hooks/telegram', 'POST', undefined, 'foreign.example')).status).toBe(404);
  expect((await send('/hooks/flow/missing', 'POST', undefined, 'foreign.example')).status).toBe(404);
  for (const path of ['/mcp', '/oauth/token', '/api/cli', '/api/sessions/start', '/api/team', '/teams/messages']) expect((await send(path, 'POST', act, 'foreign.example')).status, path).toBe(421);
});
