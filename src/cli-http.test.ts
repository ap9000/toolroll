import { afterEach, beforeEach, expect, test } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { handleCliHttp, cliRequest, CLI_FILES_BYTES, type Principal, type RunOperateAs } from './cli-http.js';
import type { Store } from './store.js';
import { PRIVATE_PATH, REMOTE_PATH_CASES } from '../test/remote-path-cases.js';
import { contractRow, STEP_UP_MESSAGE, type RemoteCommandLookup, type RemoteMode } from './remote-command.js';

const BOB: Principal = { kind: 'person', account: 'bob', generation: 3, scope: 'act', tokenId: 'abcdefabcdef', projects: ['/repo/a'] };
const TOKEN = `so_abcdefabcdef_${'x'.repeat(43)}`;
const store = {} as Store;
let server: Server, base: string, calls: { argv: string[]; opts: Parameters<RunOperateAs>[1] }[], principal: Principal | null, runner: RunOperateAs | null;
let modeOf: RemoteCommandLookup | undefined, resolutions: number;
const MODES: Record<string, RemoteMode> = { status: 'yes', 'task add': 'yes', 'task wait': 'yes', 'task approve': 'step-up', 'repos add': 'no', 'flows create': 'yes', 'flows script save': 'yes' };

beforeEach(async () => {
  calls = []; principal = BOB; resolutions = 0;
  modeOf = argv => { const row = contractRow(argv); return row === null ? null : { ...row, mode: MODES[row.invocation] ?? 'no' }; };
  runner = async (argv, opts) => { calls.push({ argv, opts }); opts.write('line one'); opts.write('{"ok":true}'); return 3; };
  server = createServer((request, response) => {
    void handleCliHttp(request, response, { authenticate: () => principal, run: async () => { resolutions++; return runner; }, modeOf, store }).then(handled => { if (!handled) { response.writeHead(404); response.end(); } });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address !== 'object') throw new Error('listen');
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

const post = (body: unknown, headers: Record<string, string> = {}, path = '/api/cli') => fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test.each([
  { argv: ['task', 'approve', 'T-1'], code: 'step-up', message: STEP_UP_MESSAGE },
  { argv: ['repos', 'add', '/repo/a'], code: 'remote-refused', message: 'This command cannot run remotely.' },
  { argv: ['not-a-command'], code: 'remote-refused', message: 'This command cannot run remotely.' },
])('the endpoint refuses $argv before resolving the runner', async ({ argv, code, message }) => {
  const response = await post({ argv });
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ ok: false, code, message });
  expect(resolutions).toBe(0);
  expect(calls).toHaveLength(0);
});

test('the endpoint defaults to the shared guide and refuses rows without remote permission', async () => {
  modeOf = undefined;
  const response = await post({ argv: ['serve'] });
  expect(response.status).toBe(403);
  expect(resolutions).toBe(0);
  expect(calls).toHaveLength(0);
});

test.each(['--token', '--token-file', '--token-env', '--db'].flatMap(flag => [
  { flag, args: [flag, 'private-value'] }, { flag, args: [`${flag}=private-value`] },
]))('the endpoint refuses local-only $args without echoing its value', async ({ flag, args }) => {
  const response = await post({ argv: ['task', 'add', 'Fix it', ...args] });
  expect(response.status).toBe(403);
  const failure = await response.json();
  expect(failure).toMatchObject({ ok: false, code: 'local-only-flag' });
  expect(failure.message).toContain(flag);
  expect(JSON.stringify(failure)).not.toContain('private-value');
  expect(resolutions).toBe(0);
  expect(calls).toHaveLength(0);
});

test('runs the argv once as the token\'s person and returns exit code and exact output', async () => {
  const response = await post({ argv: ['flows', 'create', '--steps', 'plan.txt'], files: { 'plan.txt': 'one\ntwo\n' } });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ exitCode: 3, stdout: 'line one\n{"ok":true}\n', stderr: '' });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.argv).toEqual(['flows', 'create', '--steps', 'plan.txt']);
  expect(calls[0]!.opts).toMatchObject({ principal: BOB, store, source: 'api', files: { 'plan.txt': 'one\ntwo\n' } });
});

test.each([
  ['flows', 'create', '--steps', 'plan.txt'],
  ['flows', 'create', '--steps=plan.txt'],
  ['flows', 'script', 'save', '--body', 'plan.txt'],
  ['flows', 'script', 'save', '--body=plan.txt'],
].map(argv => ({ argv })))('the endpoint requires inline contents for $argv', async ({ argv }) => {
  const response = await post({ argv });
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: 'missing-file', message: expect.stringContaining('input file') });
  expect(resolutions).toBe(0);
  expect(calls).toHaveLength(0);
  const accepted = await post({ argv, files: { 'plan.txt': '' } });
  expect(accepted.status).toBe(200);
  expect(calls[0]?.argv).toEqual(argv);
  expect(calls[0]?.opts.files).toEqual({ 'plan.txt': '' });
});

test('every file reference must be inlined, and file keys cannot name ordinary arguments', async () => {
  const argv = ['flows', 'create', '--steps=first.txt', '--steps', 'second.txt'];
  expect((await post({ argv, files: { 'first.txt': 'first' } })).status).toBe(403);
  for (const argv of [['task', 'add', 'plan.txt'], ['flows', 'create', '--name=plan.txt'], ['flows', 'create', '--name', 'plan.txt']]) {
    expect((await post({ argv, files: { 'plan.txt': 'unreferenced' } })).status).toBe(400);
  }
  expect(resolutions).toBe(0);
  expect(calls).toHaveLength(0);
  const files = { 'first.txt': '一\n', 'second.txt': 'two\n' };
  expect((await post({ argv, files })).status).toBe(200);
  expect(calls[0]?.argv).toEqual(argv);
  expect(calls[0]?.opts.files).toEqual(files);
});

test('a declared --file switch does not turn a positional argument into a file reference', async () => {
  modeOf = () => ({ invocation: 'template apply', mode: 'yes', mutation: 'unkeyed', flags: [{ name: 'file', takesValue: false }] });
  const argv = ['template', 'apply', '--file', 'plan.txt'];
  expect((await post({ argv, files: { 'plan.txt': 'unreferenced' } })).status).toBe(400);
  expect(resolutions).toBe(0);
  expect((await post({ argv })).status).toBe(200);
  expect(calls[0]?.argv).toEqual(argv);
  expect(calls[0]?.opts.files).toEqual({});
});

test('empty or missing file paths are refused before resolving the runner', async () => {
  for (const [command, flag] of [['flows create', '--steps'], ['flows script save', '--body']] as const) {
    for (const args of [[flag], [`${flag}=`], [flag, '--json']]) {
      expect((await post({ argv: [...command.split(' '), ...args] })).status).toBe(403);
    }
  }
  expect(resolutions).toBe(0);
  expect(calls).toHaveLength(0);
});

test.each(REMOTE_PATH_CASES)('direct-request path inventory: $name', async ({ argv, row, policy }) => {
  // Force even a local-only row to yes: the path check must independently precede runner lookup.
  modeOf = () => row;
  const missing = await post({ argv });
  expect(missing.status).toBe(403);
  expect(JSON.stringify(await missing.json())).not.toContain(PRIVATE_PATH);
  expect(resolutions).toBe(0);
  expect(calls).toHaveLength(0);
  const supplied = await post({ argv, files: { [PRIVATE_PATH]: 'supplied contents' } });
  if (policy === 'inline') {
    expect(supplied.status).toBe(200);
    expect(resolutions).toBe(1);
    expect(calls[0]?.argv).toEqual(argv);
    expect(calls[0]?.opts.files).toEqual({ [PRIVATE_PATH]: 'supplied contents' });
  } else {
    expect(supplied.status).toBe(403);
    expect(JSON.stringify(await supplied.json())).not.toContain(PRIVATE_PATH);
    expect(resolutions).toBe(0);
    expect(calls).toHaveLength(0);
  }
});

test('safe literals cannot smuggle extra files; positional inputs respect flag arity and reject server stdin', async () => {
  modeOf = argv => { const row = contractRow(argv); return row === null ? null : { ...row, mode: 'yes' }; };
  for (const argv of [
    ['flows', 'create', '--steps={"steps":[]}'],
    ['flows', 'trigger', 'add', '42', '{"kind":"button"}'],
    ['flows', 'import', 'https://gist.github.com/alice/123'],
  ]) {
    expect((await post({ argv, files: { [argv.at(-1)!]: 'unreferenced' } })).status).toBe(400);
  }
  for (const argv of [
    ['flows', 'create', '--steps=-'],
    ['flows', 'script', 'save', '--body=-'],
    ['flows', 'trigger', 'add', '42', '-'],
    ['flows', 'trigger', 'add', '--unknown', '42', PRIVATE_PATH],
  ]) {
    expect((await post({ argv, files: { '-': 'cannot enable stdin', [PRIVATE_PATH]: 'cannot change argument arity' } })).status).toBe(403);
  }
  expect(resolutions).toBe(0);
  expect(calls).toHaveLength(0);
  const argv = ['flows', 'trigger', 'add', '--as', 'alice', '42', '--json', PRIVATE_PATH];
  expect((await post({ argv, files: { [PRIVATE_PATH]: '{"kind":"button"}' } })).status).toBe(200);
  expect(calls[0]?.argv).toEqual(argv);
  expect(calls[0]?.opts.files).toEqual({ [PRIVATE_PATH]: '{"kind":"button"}' });
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
  expect((await post({ argv: ['flows', 'create', '--steps', 'a.txt'], files: { 'a.txt': 'x'.repeat(CLI_FILES_BYTES + 1) } })).status).toBe(413);
  expect((await post({ argv: ['task', 'wait', 'T-1'] })).status).toBe(400);
  expect((await post({ argv: ['task', 'wait', 'T-1', '--timeout', '26'] })).status).toBe(400);
  expect((await fetch(`${base}/api/cli`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(405);
  expect(calls).toHaveLength(0);
  expect((await post({ argv: ['task', 'wait', 'T-1', '--timeout', '25'] })).status).toBe(200);
  expect(cliRequest({ argv: ['flows', 'create', '--steps=a.txt'], files: { 'a.txt': 'ok' } })).toEqual({ argv: ['flows', 'create', '--steps=a.txt'], files: { 'a.txt': 'ok' } });
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
