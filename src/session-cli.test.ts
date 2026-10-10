/**
 * D7: `toolroll session …` sends its checked request over the saved connection's POST /api/cli with the API token,
 * never a password. A lost answer to a mutation is uncertain and never retried; an answer about a different session,
 * key or thread is not trusted; every refusal to sign in names `toolroll tokens create`.
 */
import { afterEach, beforeEach, expect, test } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSessionCommand, SESSION_PROMPT_FILE, type SessionCliOptions } from './session-cli.js';
import type { SessionResponse } from './session-contract.js';

const TOKEN = `so_abcdefabcdef_${'y'.repeat(43)}`;
const session = { id: 'saved-session', repo: '/admitted/project', title: 'Improve copy', status: 'working', nativeThreadId: 'native-thread', turnId: 'native-turn', revision: 4 };
const SEND = ['send', 'saved-session', '--key', 'same_request_key_123', '--revision', '4', '--thread', 'native-thread', '--turn', 'none'];
let dir: string, profileFile: string, sent: RequestInit[], out: string[], err: string[], reply: () => Response;

function saveProfile(token: string): void {
  mkdirSync(join(dir, 'remote'), { recursive: true, mode: 0o700 });
  writeFileSync(profileFile, JSON.stringify({ version: 1, active: 'work', profiles: { work: { origin: 'https://toolroll.example.com', account: 'operator', token } } }), { mode: 0o600 });
  chmodSync(profileFile, 0o600);
}
const options = (): SessionCliOptions => ({ profileFile, readStdin: async () => 'Also the error state.', stderr: line => { err.push(line); },
  fetch: (async (url: string, init: RequestInit) => { expect(url).toBe('https://toolroll.example.com/api/cli'); sent.push(init); return reply(); }) as unknown as typeof fetch });
const answered = (response: SessionResponse, exitCode = 0) => () => new Response(JSON.stringify({ exitCode, stdout: JSON.stringify(response), stderr: '' }), { status: 200 });
const delivered: SessionResponse = { version: 1, operation: 'send', ok: true, status: 'succeeded', delivery: 'confirmed', retry: 'inspect-first', message: 'Message delivered.', nextActions: [],
  result: { session, receipt: { key: 'same_request_key_123', status: 'accepted' } } };
const run = (argv: string[]) => runSessionCommand(argv, line => { out.push(line); }, options());

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'toolroll-session-cli-'));
  profileFile = join(dir, 'remote', 'profiles.json');
  sent = []; out = []; err = [];
  reply = answered(delivered);
  saveProfile(TOKEN);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('a session operation posts its exact argv and prompt to /api/cli with the bare API token', async () => {
  expect(await run([...SEND, '--stdin', '--json'])).toBe(0);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ method: 'POST', redirect: 'manual', credentials: 'omit' });
  expect((sent[0]!.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  expect(JSON.parse(String(sent[0]!.body))).toEqual({
    argv: ['session', 'send', 'saved-session', '--key', 'same_request_key_123', '--revision', '4', '--thread', 'native-thread', '--turn', 'none', '--file', SESSION_PROMPT_FILE, '--json'],
    files: { [SESSION_PROMPT_FILE]: 'Also the error state.' } });
  expect(JSON.parse(out[0]!)).toMatchObject({ ok: true, status: 'succeeded', command: 'session send', key: 'same_request_key_123' });
});

test('a lost answer to a mutation is uncertain, says how to inspect, and is sent exactly once', async () => {
  reply = () => { throw new Error('connection reset'); };
  expect(await run([...SEND, '--stdin', '--json'])).toBe(1);
  expect(sent).toHaveLength(1);
  expect(JSON.parse(out[0]!)).toMatchObject({ ok: false, status: 'uncertain', delivery: 'unknown', retry: 'inspect-first', nextActions: [{ operation: 'show', sessionId: 'saved-session' }] });
  // A command that stopped on the server may have acted: also uncertain, never "not sent".
  reply = () => new Response(JSON.stringify({ ok: false, code: 'command-failed', message: 'stopped' }), { status: 500 });
  out = [];
  expect(await run([...SEND, '--stdin', '--json'])).toBe(1);
  expect(JSON.parse(out[0]!)).toMatchObject({ status: 'uncertain', delivery: 'unknown' });
});

test('an answer about a different session, key or thread is not trusted', async () => {
  for (const changed of [{ ...delivered, result: { ...delivered.result, session: { ...session, id: 'other-session' } } },
    { ...delivered, result: { ...delivered.result, receipt: { key: 'another_request_key_1', status: 'accepted' } } },
    { ...delivered, result: { ...delivered.result, session: { ...session, nativeThreadId: 'other-thread' } } }]) {
    reply = answered(changed);
    out = [];
    expect(await run([...SEND, '--stdin', '--json'])).toBe(1);
    expect(JSON.parse(out[0]!)).toMatchObject({ status: 'uncertain', delivery: 'unknown' });
  }
});

test('a refusal before anything ran is rejected and not sent', async () => {
  reply = () => new Response(JSON.stringify({ ok: false, code: 'rate-limited', message: 'Request limit reached.' }), { status: 429 });
  expect(await run([...SEND, '--stdin', '--json'])).toBe(3);
  expect(JSON.parse(out[0]!)).toMatchObject({ ok: false, status: 'rejected', delivery: 'not-sent', retry: 'never', reason: 'rate-limited', message: 'Request limit reached.' });
});

test('without a saved API token, or with the retired password flags, nothing is sent and the replacement is named', async () => {
  for (const argv of [['list', '--url', 'https://toolroll.example.com'], ['list', '--as', 'operator'], ['list', '--token-env', 'SECRET']]) {
    err = [];
    expect(await run(argv), argv.join(' ')).toBe(2);
    expect(err.join('\n')).toContain('toolroll tokens create');
  }
  saveProfile('a-password-not-a-token');
  err = [];
  expect(await run(['list'])).toBe(2);
  expect(err.join('\n')).toContain('toolroll tokens create');
  expect(sent).toEqual([]);
});
