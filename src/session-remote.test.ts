/**
 * D7: every native session operation runs over POST /api/cli with an API token, through the existing session owner.
 * The transport admits and budgets it like any remote command; the runner binds the token's person to the owner,
 * refuses read and project-limited tokens before a mutation, records the request in the ledger, and never claims an
 * outcome it could not confirm.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from './store.js';
import { addApprover } from './scope.js';
import { mintApiToken } from './api-tokens.js';
import { handleCliHttp } from './cli-http.js';
import type { Principal } from './operate-remote.js';
import type { CodingWorkspace } from './coding-workspace.js';
import { SESSION_OPERATIONS, sessionDescriptor, type SessionOperation, type SessionResponse } from './session-contract.js';
import { sessionArgv, SESSION_PROMPT_FILE } from './session-cli.js';

const execute = vi.fn();
vi.mock('./session-service.js', () => ({ SessionService: class { execute = execute; } }));
const { createSessionRunner } = await import('./session-remote.js');

const session = { id: 'saved-session', repo: '/admitted/project', title: 'Improve empty-state copy', status: 'working', nativeThreadId: 'native-thread', turnId: 'native-turn', revision: 4 };
const KEY = 'same_request_key_123';
const expected = { sessionId: session.id, key: KEY, expectedRevision: 4, expectedThreadId: 'native-thread', expectedTurnId: null };
/** One valid request per operation, as the client would send it. */
const REQUESTS: Record<SessionOperation, Record<string, unknown>> = {
  list: { version: 1, limit: 5 }, show: { version: 1, sessionId: session.id, view: 'activity' }, changes: { version: 1, sessionId: session.id },
  start: { version: 1, project: '/admitted/project', title: 'Improve copy', prompt: 'Clarify the empty state.', key: KEY },
  send: { version: 1, ...expected, prompt: 'Also the error state.' }, stop: { version: 1, ...expected }, resume: { version: 1, ...expected }, recover: { version: 1, ...expected },
};
const success = (operation: SessionOperation): SessionResponse => ({ version: 1, operation, ok: true, status: 'succeeded', delivery: 'confirmed', retry: sessionDescriptor(operation)!.mutation ? 'inspect-first' : 'safe-read',
  message: 'Done.', nextActions: [], result: operation === 'list' ? { sessions: [session] } : { session, ...(operation === 'changes' ? { changes: { head: 'abc', status: 'M a', diff: '', truncated: false } } : {}), ...('key' in REQUESTS[operation] ? { receipt: { key: KEY, status: 'accepted' } } : {}) } });

let dir: string, store: Store, server: Server, base: string, principal: Principal;
let admitted: number;
const mint = (name: string, projects: string[] | null): string => {
  const minted = mintApiToken();
  store.createApiToken({ id: minted.id, account: 'operator', name, secretHash: minted.hash, access: 'act', expiresAt: new Date(Date.now() + 86_400_000).toISOString(), by: 'operator', projects }, new Date());
  return minted.id;
};
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'toolroll-session-remote-'));
  store = openStore(join(dir, 'orders.db'));
  if (!addApprover(store, 'operator', new Date()).ok) throw new Error('bootstrap');
  principal = { kind: 'person', account: 'operator', generation: store.accountOf('operator')!.generation, scope: 'act', tokenId: mint('laptop', null), projects: null };
  execute.mockReset(); admitted = 0;
  const runner = createSessionRunner({ store, workspace: {} as CodingWorkspace, projects: () => ['/admitted/project'], projectAllowed: () => true });
  server = createServer((request, response) => {
    void handleCliHttp(request, response, { store, authenticate: () => principal, admit: () => { admitted += 1; return { ok: true }; }, run: async () => null, session: runner });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No HTTP address');
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = async (operation: SessionOperation, request = REQUESTS[operation]) => {
  const spec = sessionDescriptor(operation)!;
  const argv = sessionArgv(spec, request as never);
  const files = typeof request['prompt'] === 'string' ? { [SESSION_PROMPT_FILE]: request['prompt'] } : {};
  const response = await fetch(`${base}/api/cli`, { method: 'POST', headers: { authorization: `Bearer so_abcdefabcdef_${'y'.repeat(43)}`, 'content-type': 'application/json' }, body: JSON.stringify({ argv, files }) });
  expect(response.status).toBe(200);
  const answer = await response.json() as { exitCode: number; stdout: string };
  return { exitCode: answer.exitCode, envelope: JSON.parse(answer.stdout) as SessionResponse & { command: string } };
};
const ledger = () => store.handle.prepare("SELECT action, outcome, detail FROM action_ledger WHERE action LIKE 'remote command: session%' ORDER BY id").all();

describe('every session operation runs over /api/cli', () => {
  test.each([...SESSION_OPERATIONS])('%s reaches the session owner once, as the token\'s person, with the exact request', async operation => {
    execute.mockResolvedValue(success(operation));
    const { exitCode, envelope } = await call(operation);
    expect(exitCode).toBe(0);
    expect(envelope).toMatchObject({ ...success(operation), command: `session ${operation}` });
    expect(execute).toHaveBeenCalledExactlyOnceWith({ name: 'operator', generation: principal.generation }, operation, REQUESTS[operation]);
    expect(admitted).toBe(1);
    expect(ledger()).toEqual([
      { action: `remote command: session ${operation}`, outcome: 'requested', detail: 'token laptop' },
      { action: `remote command: session ${operation}`, outcome: 'done', detail: 'token laptop' },
    ]);
  });
});

test('a read token reads sessions but never changes one; nothing reaches the owner', async () => {
  principal = { ...principal, scope: 'read' };
  execute.mockResolvedValue(success('list'));
  expect((await call('list')).exitCode).toBe(0);
  execute.mockClear();
  for (const operation of ['start', 'send', 'stop', 'resume', 'recover'] as const) {
    const { exitCode, envelope } = await call(operation);
    expect(exitCode, operation).toBe(3);
    expect(envelope).toMatchObject({ operation, ok: false, status: 'rejected', delivery: 'not-sent', retry: 'never', reason: 'read-only' });
  }
  expect(execute).not.toHaveBeenCalled();
});

test('a principal narrowed to some projects, or a project-limited token, has no session access', async () => {
  principal = { ...principal, projects: ['/admitted/project'] };
  expect((await call('list')).envelope).toMatchObject({ ok: false, status: 'rejected', delivery: 'not-sent', retry: 'safe-read', reason: 'all-projects' });
  principal = { ...principal, tokenId: mint('limited', ['/admitted/project']) };
  expect((await call('start')).envelope).toMatchObject({ ok: false, delivery: 'not-sent', reason: 'all-projects' });
  expect(execute).not.toHaveBeenCalled();
});

test('a lost or malformed owner answer to a mutation is uncertain, names how to inspect, and is not retried', async () => {
  execute.mockRejectedValueOnce(new Error('connection reset'));
  const thrown = await call('send');
  expect(thrown.exitCode).toBe(1);
  expect(thrown.envelope).toMatchObject({ operation: 'send', ok: false, status: 'uncertain', delivery: 'unknown', retry: 'inspect-first',
    nextActions: [{ operation: 'show', sessionId: session.id }] });
  execute.mockResolvedValueOnce({ version: 1, operation: 'stop', ok: true });
  expect((await call('stop')).envelope).toMatchObject({ status: 'uncertain', delivery: 'unknown', reason: 'unconfirmed-response' });
  expect(execute).toHaveBeenCalledTimes(2);
  expect(ledger().map(row => row['outcome'])).toEqual(['requested', 'failed', 'requested', 'failed']);
});

test('the prompt is only the request\'s own file: a missing or extra file is refused before the owner', async () => {
  const argv = sessionArgv(sessionDescriptor('send')!, REQUESTS.send as never);
  const post = (files: Record<string, string>) => fetch(`${base}/api/cli`, { method: 'POST', headers: { authorization: `Bearer so_abcdefabcdef_${'y'.repeat(43)}`, 'content-type': 'application/json' }, body: JSON.stringify({ argv, files }) });
  const missing = await post({});
  expect(JSON.parse((await missing.json() as { stdout: string }).stdout)).toMatchObject({ ok: false, delivery: 'not-sent', reason: 'usage' });
  const extra = await post({ [SESSION_PROMPT_FILE]: 'x', other: 'y' });
  expect(extra.status).toBe(400);
  expect(execute).not.toHaveBeenCalled();
});
