/**
 * The handler registry, at the real server: constructing it checks the domain factories' registrations against the
 * route table, and every row's own sample, sent with its own method by a caller the row admits, reaches that row's
 * handler. Undeclared console addresses and wrong methods reach none.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { request as httpRequest, type Server } from 'node:http';
import { openStore, type Store } from '../store.js';
import { addApprover } from '../scope.js';
import { createDecisionServer } from '../serve.js';
import * as registry from './handler-registry.js';
import { assertHandlerRegistry, type Registration } from './handler-registry.js';
import { ROUTES, type RouteDeclaration } from './route-table.js';

/** A complete registry made from the table itself: one compatible entry per row. */
const synthetic = (): Registration[] => ROUTES.map(row => ({ id: row.id, domain: row.domain, stage: row.stage, method: row.method, handle: async () => {} }) as Registration);

describe('assertHandlerRegistry', () => {
  test('a complete registry passes; a missing, duplicate or incompatible entry fails startup', () => {
    const all = synthetic();
    expect(() => assertHandlerRegistry(all)).not.toThrow();
    const [first, second] = all.filter(one => one.stage === 'console');
    expect(() => assertHandlerRegistry(all.map(one => one === second ? { ...second!, handle: first!.handle } as Registration : one))).toThrow(/Handler shared by/);
    expect(() => assertHandlerRegistry(all.slice(1))).toThrow(/Route has no handler/);
    expect(() => assertHandlerRegistry([...all, all[0]!])).toThrow(/Duplicate handler/);
    expect(() => assertHandlerRegistry([...all, { ...all[0]!, id: 'not-declared' }])).toThrow(/no compatible route/);
    const swap = (index: number, change: Partial<RouteDeclaration>) => all.map((one, at) => at === index ? { ...one, ...change } as Registration : one);
    const console_ = all.findIndex(one => one.stage === 'console');
    expect(() => assertHandlerRegistry(swap(console_, { domain: all[console_]!.domain === 'tasks' ? 'flows' : 'tasks' }))).toThrow(/no compatible route/);
    expect(() => assertHandlerRegistry(swap(console_, { stage: 'edge' }))).toThrow(/no compatible route/);
  });
});

describe('the server', () => {
  const REPO = '/repo/main';
  let store: Store, server: Server, port: number, password: string;
  /** Route ids that reached their handler. Until `live` is cleared, handlers run (to sign in); afterwards they only record. */
  let reached: string[], live: boolean, registered: Registration[];

  beforeEach(async () => {
    reached = []; live = true;
    const actual = registry.createHandlerRegistry;
    vi.spyOn(registry, 'createHandlerRegistry').mockImplementation(registrations => {
      registered = [...registrations];
      return actual(registrations.map(one => ({ ...one, handle: async (ctx: Parameters<typeof one.handle>[0]) => {
        reached.push(one.id);
        if (live) return (one.handle as (ctx: unknown) => Promise<void>)(ctx);
        ctx.response.statusCode = 204; ctx.response.end();
      } }) as Registration));
    });
    store = openStore(':memory:');
    const alex = addApprover(store, 'alex', new Date());
    if (!alex.ok) throw new Error('alex');
    password = alex.token;
    server = createDecisionServer({ store, evidenceRoot: '/unused-registry-evidence', repo: REPO });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });
  afterEach(async () => {
    if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    store.close(); vi.restoreAllMocks();
  });

  function send(path: string, method: string, headers: Record<string, string> = {}, body = ''): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}`, connection: 'close', 'content-type': 'application/x-www-form-urlencoded', ...headers } }, response => {
        let text = '';
        response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
        response.on('end', () => resolve({ status: response.statusCode!, body: text, headers: response.headers }));
      });
      request.on('error', reject); request.end(method === 'POST' ? body : undefined);
    });
  }
  async function signIn(): Promise<{ cookie: string; csrf: string }> {
    const answer = await send('/login', 'POST', {}, new URLSearchParams({ name: 'alex', token: password }).toString());
    expect(answer.status).toBe(303);
    const cookie = (answer.headers['set-cookie'] as string[]).map(one => one.split(';')[0]!).find(one => one.startsWith('standing-orders_session='))!;
    const page = await send('/tasks', 'GET', { cookie });
    return { cookie, csrf: /name="csrf" value="([0-9a-f]{64})"/.exec(page.body)![1]! };
  }

  test('starts with every factory registration, and every row reaches its own handler', async () => {
    // Construction ran assertHandlerRegistry on the factories' own list.
    expect(new Set(registered.map(one => one.handle)).size).toBe(registered.length);
    expect(registered.map(one => one.id).sort()).toEqual(ROUTES.map(row => row.id).sort());
    const { cookie, csrf } = await signIn();
    live = false;
    const missed: string[] = [];
    for (const row of ROUTES) {
      reached = [];
      const method = row.method === 'POST' ? 'POST' : 'GET';
      // Console rows as the signed-in browser; edge rows as the anonymous caller their own proof starts from.
      const answer = (row.stage === 'console' || row.domain === 'live')
        ? await send(row.sample, method, { cookie, origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' }, new URLSearchParams({ csrf }).toString())
        : await send(row.sample, method);
      if (reached.join() !== row.id || answer.status !== 204) missed.push(`${row.id} ${method} ${row.sample}: ${answer.status} ${reached.join()}`);
    }
    expect(missed).toEqual([]);
  });

  test('an undeclared console address or a wrong method reaches no handler', async () => {
    const { cookie, csrf } = await signIn();
    live = false; reached = [];
    const browser = { cookie, origin: `http://127.0.0.1:${port}` }, form = new URLSearchParams({ csrf }).toString();
    for (const path of ['/nope', '/settings/nope', '/t/a/b/c', '/flows/0/live']) {
      for (const method of ['GET', 'POST']) {
        const answer = await send(path, method, browser, form);
        expect([method, path, answer.status, answer.body]).toEqual([method, path, 404, expect.stringContaining("There&#39;s no page at this address.")]);
      }
    }
    // A declared path asked with the other method is equally unknown; any other method is refused outright.
    expect((await send('/board', 'POST', browser, form)).status).toBe(404);
    expect((await send('/tasks/add', 'GET', browser)).status).toBe(404);
    expect(await send('/board', 'DELETE', browser)).toMatchObject({ status: 405, body: 'no such method here' });
    expect(reached).toEqual([]);
  });
});
