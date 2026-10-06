import { afterEach, beforeEach, expect, test } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { handleCliHttp, cliRequest, CLI_FILES_BYTES, type Principal, type RunOperateAs } from './cli-http.js';
import type { Store } from './store.js';

const BOB: Principal = { kind: 'person', account: 'bob', generation: 3, scope: 'act', tokenId: 'abcdefabcdef', projects: ['/repo/a'] };
const TOKEN = `so_abcdefabcdef_${'x'.repeat(43)}`;
const store = {} as Store;
let server: Server, base: string, calls: { argv: string[]; opts: Parameters<RunOperateAs>[1] }[], principal: Principal | null, runner: RunOperateAs | null;

beforeEach(async () => {
  calls = []; principal = BOB;
  runner = async (argv, opts) => { calls.push({ argv, opts }); opts.write('line one'); opts.write('{"ok":true}'); return 3; };
  server = createServer((request, response) => {
    void handleCliHttp(request, response, { authenticate: () => principal, run: async () => runner, store }).then(handled => { if (!handled) { response.writeHead(404); response.end(); } });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address !== 'object') throw new Error('listen');
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

const post = (body: unknown, headers: Record<string, string> = {}, path = '/api/cli') => fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('runs the argv once as the token\'s person and returns exit code and exact output', async () => {
  const response = await post({ argv: ['task', 'add', 'Fix it', '--steps', 'plan.txt'], files: { 'plan.txt': 'one\ntwo\n' } });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ exitCode: 3, stdout: 'line one\n{"ok":true}\n', stderr: '' });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.argv).toEqual(['task', 'add', 'Fix it', '--steps', 'plan.txt']);
  expect(calls[0]!.opts).toMatchObject({ principal: BOB, store, source: 'api', files: { 'plan.txt': 'one\ntwo\n' } });
});

test('refuses browsers, cookies, passwords, duplicate or missing credentials and URL data without running anything', async () => {
  expect((await post({ argv: ['status'] }, { origin: base })).status).toBe(403);
  expect((await post({ argv: ['status'] }, { cookie: 'standing-orders_session=abc' })).status).toBe(400);
  expect((await post({ argv: ['status'] }, { authorization: 'Bearer alice:hunter2' })).status).toBe(401);
  expect((await post({ argv: ['status'] }, { authorization: '' })).status).toBe(401);
  expect((await post({ argv: ['status'] }, {}, '/api/cli?token=x')).status).toBe(400);
  const doubled = await new Promise<number>((resolve, reject) => {
    const outgoing = httpRequest(`${base}/api/cli`, { method: 'POST', headers: [['authorization', `Bearer ${TOKEN}`], ['authorization', `Bearer ${TOKEN}`], ['content-type', 'application/json']] as unknown as Record<string, string> }, incoming => { incoming.resume(); resolve(incoming.statusCode ?? 0); });
    outgoing.on('error', reject); outgoing.end(JSON.stringify({ argv: ['status'] }));
  });
  expect(doubled).toBe(400);
  principal = null;
  const revoked = await post({ argv: ['status'] });
  expect(revoked.status).toBe(401);
  expect(await revoked.json()).toMatchObject({ ok: false, code: 'unauthenticated' });
  expect(calls).toHaveLength(0);
});

test('only JSON {argv, files} within the 256 KiB file cap; files name real arguments', async () => {
  expect((await post({ argv: ['status'] }, { 'content-type': 'text/plain' })).status).toBe(415);
  expect((await post('{"argv":')).status).toBe(400);
  expect((await post({ argv: [] })).status).toBe(400);
  expect((await post({ argv: ['status'], extra: 1 })).status).toBe(400);
  expect((await post({ argv: ['status'], files: { '/etc/passwd': 'x' } })).status).toBe(400);
  expect((await post({ argv: ['task', 'add', '--steps', 'a.txt'], files: { 'a.txt': 'x'.repeat(CLI_FILES_BYTES + 1) } })).status).toBe(413);
  expect((await post({ argv: ['task', 'wait', 'T-1'] })).status).toBe(400);
  expect((await post({ argv: ['task', 'wait', 'T-1', '--timeout', '26'] })).status).toBe(400);
  expect((await fetch(`${base}/api/cli`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(405);
  expect(calls).toHaveLength(0);
  expect((await post({ argv: ['task', 'wait', 'T-1', '--timeout', '25'] })).status).toBe(200);
  expect(cliRequest({ argv: ['x', 'a.txt'], files: { 'a.txt': 'ok' } })).toEqual({ argv: ['x', 'a.txt'], files: { 'a.txt': 'ok' } });
});

test('a server without the command boundary says so; a crash is reported as unconfirmed, never retried', async () => {
  runner = null;
  expect(await (await post({ argv: ['status'] })).json()).toMatchObject({ code: 'remote-unavailable' });
  let runs = 0;
  runner = async () => { runs++; throw new Error('boom'); };
  const crashed = await post({ argv: ['task', 'add', 'x'] });
  expect(crashed.status).toBe(500);
  expect(runs).toBe(1);
});
