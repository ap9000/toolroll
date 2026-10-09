/**
 * The route table's role column over HTTP, generated from ROUTES: every row
 * that names a role refuses each caller without it before its handler runs,
 * in the row's own words, and admits the role's holder past that refusal.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { mintApiToken } from '../api-tokens.js';
import { setLimitOverride } from '../request-budget.js';
import { addApprover } from '../scope.js';
import { createDecisionServer } from '../serve.js';
import { openStore, type Store } from '../store.js';
import { ROUTES, type RouteDeclaration } from './route-table.js';

let store: Store, server: Server, base: string, dir: string;
const sessions: Record<'operator' | 'limited' | 'viewer', { cookie: string; csrf: string }> = {} as never;
let act = '';

beforeAll(async () => {
  // A file database and a config folder: the operator pages that need them answer for the holder.
  dir = mkdtempSync(join(tmpdir(), 'so-roles-'));
  mkdirSync(join(dir, 'config'));
  store = openStore(join(dir, 'toolroll.db'));
  const now = new Date();
  const alex = addApprover(store, 'alex', now); if (!alex.ok) throw new Error('bootstrap');
  const lim = addApprover(store, 'lim', now, { name: 'alex', token: alex.token }); if (!lim.ok) throw new Error('limited');
  const vera = addApprover(store, 'vera', now, { name: 'alex', token: alex.token }); if (!vera.ok) throw new Error('viewer');
  store.raw().prepare("UPDATE approver SET role = 'viewer' WHERE name = 'vera'").run();
  store.raw().prepare(`UPDATE approver SET projects_json = '["/repo/main"]' WHERE name = 'lim'`).run();
  const minted = mintApiToken();
  store.createApiToken({ id: minted.id, account: 'alex', name: 'act', secretHash: minted.hash, access: 'act', expiresAt: new Date(now.getTime() + 86_400_000).toISOString(), by: 'alex' }, now);
  act = minted.token;
  setLimitOverride(store, '*', { readPerMinute: 600, actPerMinute: 600, perDay: 10000 }, 'alex', now);
  server = createDecisionServer({ store, evidenceRoot: join(dir, 'evidence'), repo: '/repo/main', configDir: join(dir, 'config'), telegramTokenFile: join(dir, 'config', 'telegram-token') });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const [key, name, password] of [['operator', 'alex', alex.token], ['limited', 'lim', lim.token], ['viewer', 'vera', vera.token]] as const) {
    const login = await fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ name, token: password }), redirect: 'manual' });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    const html = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
    sessions[key] = { cookie, csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? /"csrf":"([^"]+)"/.exec(html)?.[1] ?? '' };
  }
});
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function send(route: RouteDeclaration, headers: Record<string, string>, csrf: string | null): Promise<{ status: number; type: string; body: string }> {
  const post = route.method === 'POST';
  const response = await fetch(base + route.sample, { method: post ? 'POST' : 'GET', redirect: 'manual', headers: { ...headers, ...(post ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    ...(post ? { body: new URLSearchParams(csrf === null ? {} : { csrf }) } : {}) });
  const type = response.headers.get('content-type') ?? '';
  const body = type.includes('event-stream') ? (await response.body?.cancel(), '') : await response.text();
  return { status: response.status, type, body };
}
const refusalText = (route: RouteDeclaration): string => {
  const refusal = route.roleRefusal!;
  return 'message' in refusal ? refusal.message : refusal.body;
};
const said = (route: RouteDeclaration, answer: { body: string }): boolean =>
  answer.body === refusalText(route) || answer.body.includes(refusalText(route).replaceAll('&', '&amp;').replaceAll("'", '&#39;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'));

const roleRows = ROUTES.filter(route => route.role !== 'any');

test('every role row names the words a caller without the role hears', () => {
  expect(roleRows.length).toBeGreaterThan(80);
  for (const route of ROUTES) expect(route.role === 'any', route.id).toBe(route.roleRefusal === undefined);
});

test('a caller without the role never gets past admission, and an admitted one without it hears exactly the row', async () => {
  for (const route of roleRows) {
    const callers = [
      { name: 'viewer', headers: { cookie: sessions.viewer.cookie }, csrf: sessions.viewer.csrf, holds: false },
      { name: 'limited', headers: { cookie: sessions.limited.cookie }, csrf: sessions.limited.csrf, holds: route.role === 'approver' },
      { name: 'token', headers: { authorization: `Bearer ${act}` }, csrf: null, holds: !route.roleBrowser },
    ];
    for (const caller of callers.filter(one => !one.holds)) {
      const answer = await send(route, caller.headers, caller.csrf);
      // An earlier admission refusal (caller, scope, project, opener) may answer first; nothing reaches the handler.
      expect([303, 401, 403, 404], `${route.id} ${caller.name}`).toContain(answer.status);
      if (answer.status === 403 && caller.name === 'token' && route.callers.includes('bearer') && route.scope !== 'step-up') {
        expect(said(route, answer), `${route.id} ${caller.name}: ${answer.body.slice(0, 200)}`).toBe(true);
      }
    }
  }
});

test('a viewer reading a role page hears the row refusal, in the console', async () => {
  // A page that first needs an open project sends a session with none to the opener.
  const reads = roleRows.filter(route => route.method !== 'POST' && !route.needsProject);
  expect(reads.length).toBeGreaterThan(15);
  for (const route of reads) {
    const answer = await send(route, { cookie: sessions.viewer.cookie }, null);
    expect(answer.status, route.id).toBe(403);
    if ('message' in route.roleRefusal!) expect(answer.type, route.id).toContain('text/html');
    else expect(answer.type, route.id).toBe(route.roleRefusal!.type);
    expect(said(route, answer), `${route.id}: ${answer.body.slice(0, 200)}`).toBe(true);
  }
});

test('the role holder is never refused by the role', async () => {
  for (const route of roleRows) {
    const answer = await send(route, { cookie: sessions.operator.cookie }, sessions.operator.csrf);
    expect(answer.status === 403 && said(route, answer), route.id).toBe(false);
  }
});
