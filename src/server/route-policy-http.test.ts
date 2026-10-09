import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { createHash } from 'node:crypto';
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

const REPO = '/repo/main';
let store: Store, server: Server, port: number, act: string, read: string, password: string;
beforeEach(async () => {
  store = openStore(':memory:');
  const now = new Date();
  const operator = addApprover(store, 'operator', now);
  if (!operator.ok) throw Error('operator');
  password = operator.token;
  const token = (access: 'read' | 'act') => {
    const minted = mintApiToken();
    store.createApiToken({ id: minted.id, account: 'operator', name: access, secretHash: minted.hash, access, expiresAt: new Date(now.getTime() + 86400000).toISOString(), by: 'operator' }, now);
    return minted.token;
  };
  act = token('act'); read = token('read');
  // Admission tests have their own suite. This matrix needs one request per declaration.
  setLimitOverride(store, '*', { readPerMinute: 600, actPerMinute: 600, perDay: 10000 }, 'operator', now);
  server = createDecisionServer({ store, evidenceRoot: '/unused-policy-evidence', repo: REPO });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});
afterEach(async () => {
  if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  store.close(); vi.restoreAllMocks();
});
function send(path: string, method = 'GET', token?: string, host?: string, browser?: { cookie?: string; form?: URLSearchParams }): Promise<{ status: number; type: string; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method, headers: {
      host: host ?? `127.0.0.1:${port}`, connection: 'close', 'content-type': browser ? 'application/x-www-form-urlencoded' : 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(browser ? { cookie: browser.cookie ?? '', origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' } : {}),
    } }, response => {
      let body = '';
      response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, type: String(response.headers['content-type'] ?? ''), body, headers: response.headers }));
    });
    request.on('error', reject); request.end(method === 'POST' ? browser?.form?.toString() ?? '{}' : undefined);
  });
}

test('a project-limited approver is refused at every console deny route without changing protected state', async () => {
  const limited = addApprover(store, 'limited', new Date(), { name: 'operator', token: password });
  if (!limited.ok) throw Error('limited');
  expect(store.setAccountProjects('limited', [REPO], 'operator', new Date())).toEqual({ ok: true });
  expect(store.accountOf('limited')).toMatchObject({ role: 'approver', projects: [REPO] });
  const login = await send('/login', 'POST', undefined, undefined, { form: new URLSearchParams({ name: 'limited', token: limited.token }) });
  expect(login.status).toBe(303);
  const cookie = login.headers['set-cookie']!.map(one => one.split(';')[0]!).find(one => one.startsWith('standing-orders_session='))!;
  const tasks = await send('/tasks', 'GET', undefined, undefined, { cookie });
  expect(tasks.status).toBe(200);
  const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(tasks.body)![1]!;

  // Refusals append audit records and advance their workspace cursor; browser reads may touch last_seen.
  // Hash every other table/field, including credentials, approvals, task/run/flow data, sessions and settings.
  const tables = store.handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
    .map(row => String(row['name'])).filter(name => !['action_ledger', 'ledger_chain', 'ledger_head', 'request_budget_usage'].includes(name));
  const snapshot = () => Object.fromEntries(tables.map(table => {
    const rows = store.handle.prepare(`SELECT * FROM "${table}"`).all()
      .filter(row => table !== 'service_cursor' || row['key'] !== 'workspace-content:v1')
      .map(row => {
        if (table === 'web_session') { const { last_seen: _seen, ...protectedFields } = row; return protectedFields; }
        return row;
      });
    return [table, createHash('sha256').update(JSON.stringify(rows)).digest('hex')];
  }));
  const before = snapshot();
  const form = new URLSearchParams({ csrf, token: limited.token, password: limited.token, repo: REPO, path: REPO,
    name: 'invited-person', role: 'approver', access: 'all', confirm: 'yes', digest: 'a'.repeat(64), reason: 'Review access' });
  for (const row of ROUTES.filter(row => row.stage === 'console' && row.limited === 'deny')) {
    const answer = await send(row.sample, row.method === 'POST' ? 'POST' : 'GET', undefined, undefined, { cookie, form });
    expect([answer.status, answer.body], row.id).toEqual([403,
      expect.stringContaining('This area requires instance access. Your account operates within its assigned projects.')]);
    expect(snapshot(), row.id).toEqual(before);
  }
  // Prove the state recorder notices domain writes.
  store.createTask({ id: 'snapshot-control', title: 'A saved task changes the snapshot' }, new Date());
  expect(snapshot()).not.toEqual(before);
});

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
  for (const [path, method] of [['/api/cli', 'GET'], ['/api/sessions/start', 'GET'], ['/api/team', 'DELETE'], ['/hooks/flow/one', 'GET'], ['/hooks/telegram', 'GET']]) {
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
