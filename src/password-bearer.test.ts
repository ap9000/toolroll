/**
 * D7: a password on a request still signs in for this one release, announced on every answer, and every refusal of
 * such a request names `toolroll tokens create`. From PASSWORD_BEARER_REFUSED_FROM on, the server refuses it before
 * checking anything.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { openStore, type Store } from './store.js';
import { addApprover } from './scope.js';
import * as scope from './scope.js';
import { createDecisionServer } from './serve.js';
import { ROUTES } from './server/route-table.js';
import { isPasswordBearer, PASSWORD_BEARER_REFUSED, PASSWORD_BEARER_REFUSED_FROM, passwordBearerAccepted, withReplacement } from './password-bearer.js';
import { PACKAGE_VERSION } from './version.js';

vi.mock('./scope.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./scope.js')>();
  return { ...actual, authenticateAccount: vi.fn(actual.authenticateAccount) };
});

describe('the removal boundary', () => {
  test('this release and the next accept a password bearer; the release that removes it, and every later one, refuse it', () => {
    expect(PASSWORD_BEARER_REFUSED_FROM).toBe('0.9.58');
    expect(passwordBearerAccepted(PACKAGE_VERSION)).toBe(true);
    for (const version of ['0.9.56', '0.9.57']) expect(passwordBearerAccepted(version), version).toBe(true);
    for (const version of ['0.9.58', '0.9.60', '0.10.0', '1.0.0']) expect(passwordBearerAccepted(version), version).toBe(false);
  });

  test('only a name and a secret is a password bearer; an API token is not', () => {
    expect(isPasswordBearer('Bearer alex:secret')).toBe(true);
    expect(isPasswordBearer(`Bearer so_abcdefabcdef_${'y'.repeat(43)}`)).toBe(false);
    expect(isPasswordBearer(undefined)).toBe(false);
    expect(withReplacement('Bearer alex:secret', 'authenticate first')).toContain('toolroll tokens create');
    expect(withReplacement(undefined, 'authenticate first')).toBe('authenticate first');
  });
});

let dir: string, repo: string, store: Store, server: Server | undefined, base: string, password: string, viewer: string;
async function serve(passwordBearer?: boolean): Promise<void> {
  server = createDecisionServer({ store, evidenceRoot: join(dir, 'evidence'), repos: [repo], configDir: dir, ...(passwordBearer === undefined ? {} : { passwordBearerAccepted: passwordBearer }) });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address !== 'object') throw new Error('listen');
  base = `http://127.0.0.1:${address.port}`;
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'so-password-bearer-'));
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'so-password-bearer-repo-')));
  store = openStore(join(dir, 'orders.db'));
  const added = addApprover(store, 'alex', new Date());
  if (!added.ok) throw new Error('bootstrap');
  password = added.token;
  const watcher = addApprover(store, 'vera', new Date(), { name: 'alex', token: password });
  if (!watcher.ok) throw new Error('viewer');
  store.raw().prepare("UPDATE approver SET role = 'viewer' WHERE name = 'vera'").run();
  viewer = watcher.token;
});
afterEach(async () => {
  if (server !== undefined) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
  store.close();
  for (const one of [dir, repo]) rmSync(one, { recursive: true, force: true });
});
const get = (path: string, authorization: string) => fetch(`${base}${path}`, { headers: { authorization }, redirect: 'manual' });
const post = (path: string, authorization: string) => fetch(`${base}${path}`, { method: 'POST', headers: { authorization, 'content-type': 'application/x-www-form-urlencoded' }, body: '', redirect: 'manual' });

test('an accepted password bearer still signs in, and every answer says it is deprecated and what replaces it', async () => {
  await serve();
  const response = await get('/work', `Bearer alex:${password}`);
  expect(response.status).toBe(200);
  expect(response.headers.get('deprecation')).toBe('true');
  expect(response.headers.get('warning')).toContain('toolroll tokens create');
  expect(response.headers.get('warning')).toContain(PASSWORD_BEARER_REFUSED_FROM);
  const team = await get('/api/team', `Bearer alex:${password}`);
  expect(team.status).toBe(200);
  expect(team.headers.get('warning')).toContain('toolroll tokens create');
  expect(await team.json()).toMatchObject({ ok: true });
});

test('every refusal of a password bearer names the replacement', async () => {
  await serve();
  // A browser-only page, an act a viewer can't take, and a step-up no bearer passes (route-table.ts declares each).
  const route = (id: string) => ROUTES.find(row => row.id === id)!;
  const browserOnly = route('projects.github'), act = route('chat.demo.ask'), stepUp = route('settings.sessions-send');
  expect([browserOnly.callers, act.scope, stepUp.scope]).toEqual([['cookie'], 'act', 'step-up']);
  const refusals: [string, Response, number][] = [
    ['invalid credentials', await get('/work', 'Bearer alex:wrong-password'), 401],
    ['disallowed route', await get(browserOnly.sample, `Bearer alex:${password}`), 403],
    ['insufficient scope', await post(act.sample, `Bearer vera:${viewer}`), 403],
    ['step-up', await post(stepUp.sample, `Bearer alex:${password}`), 403],
    ['team sign-in', await get('/api/team', 'Bearer alex:wrong-password'), 401],
    ['remote CLI', await fetch(`${base}/api/cli`, { method: 'POST', headers: { authorization: `Bearer alex:${password}`, 'content-type': 'application/json' }, body: JSON.stringify({ argv: ['status'] }) }), 401],
  ];
  for (const [name, response, status] of refusals) {
    expect(response.status, name).toBe(status);
    expect(await response.text(), name).toContain('toolroll tokens create');
  }
});

test('from the release that removes it, a password bearer is refused before the password is checked, naming the replacement', async () => {
  await serve(false);
  const check = vi.mocked(scope.authenticateAccount);
  check.mockClear();
  const page = await get('/work', `Bearer alex:${password}`);
  expect(page.status).toBe(401);
  expect(await page.text()).toBe(PASSWORD_BEARER_REFUSED);
  const team = await get('/api/team', `Bearer alex:${password}`);
  expect(team.status).toBe(401);
  expect(await team.json()).toEqual({ version: 1, ok: false, code: 'password-bearer-refused', message: PASSWORD_BEARER_REFUSED });
  expect(PASSWORD_BEARER_REFUSED).toContain('toolroll tokens create');
  expect(check).not.toHaveBeenCalled();
});
