import { afterEach, beforeEach, expect, test } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contractRow, maybeRunRemoteCommand, STEP_UP_MESSAGE, type RemoteExecOptions, type RemoteMode } from './remote-exec.js';
import { CLI_FILES_BYTES } from './cli-http.js';
import { PRIVATE_PATH, REMOTE_PATH_CASES } from '../test/remote-path-cases.js';

const TOKEN = `so_abcdefabcdef_${'y'.repeat(43)}`;
let dir: string, profileFile: string, sent: { url: string; init: RequestInit }[], out: string[], err: string[];
let reply: () => Response;

const MODES: Record<string, RemoteMode> = { status: 'yes', 'task add': 'yes', 'task show': 'yes', 'task wait': 'yes', 'task approve': 'step-up', 'repos add': 'no', 'flows create': 'yes', 'flows script save': 'yes' };
const modeOf = (argv: readonly string[]) => {
  const row = contractRow(argv);
  return row === null ? null : { ...row, mode: MODES[row.invocation] ?? 'no' as const };
};
function saveProfile(token: string): void {
  mkdirSync(join(dir, 'remote'), { recursive: true, mode: 0o700 });
  writeFileSync(profileFile, JSON.stringify({ version: 1, active: 'work', profiles: { work: { origin: 'https://toolroll.example.com', account: 'bob', token } } }), { mode: 0o600 });
  chmodSync(profileFile, 0o600);
}
const options = (extra: Partial<RemoteExecOptions> = {}): RemoteExecOptions => ({
  profileFile, cwd: dir, modeOf, stdout: chunk => { out.push(chunk); }, stderr: chunk => { err.push(chunk); },
  fetch: (async (url: string, init: RequestInit) => { sent.push({ url, init }); return reply(); }) as unknown as typeof fetch, ...extra,
});
const answer = (exitCode: number, stdout: string, stderr = '') => () => new Response(JSON.stringify({ exitCode, stdout, stderr }), { status: 200 });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'toolroll-remote-exec-'));
  profileFile = join(dir, 'remote', 'profiles.json');
  sent = []; out = []; err = [];
  reply = answer(0, '');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('with a saved API token, a remote command posts its argv with the bare token and prints the answer byte for byte', async () => {
  saveProfile(TOKEN);
  reply = answer(1, 'first\n  second without newline', 'warned\n');
  expect(await maybeRunRemoteCommand(['status', '--json'], options())).toBe(1);
  expect(out.join('')).toBe('first\n  second without newline');
  expect(err.join('')).toBe('warned\n');
  expect(sent).toHaveLength(1);
  expect(sent[0]!.url).toBe('https://toolroll.example.com/api/cli');
  expect(sent[0]!.init).toMatchObject({ method: 'POST', redirect: 'manual', credentials: 'omit' });
  expect((sent[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  expect(JSON.parse(String(sent[0]!.init.body))).toEqual({ argv: ['status', '--json'], files: {} });
});

test('no profile, a password-only profile, a local-only command or --local all run here; --profile is explicit', async () => {
  expect(await maybeRunRemoteCommand(['status'], options())).toBeNull();
  saveProfile('hunter2-password');
  expect(await maybeRunRemoteCommand(['status'], options())).toBeNull();
  expect(await maybeRunRemoteCommand(['status', '--profile', 'work'], options())).toBe(2);
  saveProfile(TOKEN);
  expect(await maybeRunRemoteCommand(['repos', 'add', '/x'], options())).toBeNull();
  expect(await maybeRunRemoteCommand(['repos', 'add', '/x', '--profile', 'work'], options())).toBe(2);
  expect(await maybeRunRemoteCommand(['task', 'show', 'T-1', '--local'], options())).toEqual({ local: ['task', 'show', 'T-1'] });
  expect(await maybeRunRemoteCommand(['chat', '--say', 'hi'], options())).toBeNull();
  expect(await maybeRunRemoteCommand(['status', '--profile', 'work'], options())).toBe(0);
  expect(JSON.parse(String(sent[0]!.init.body)).argv).toEqual(['status']);
  expect(sent).toHaveLength(1);
});

test('approvals are refused locally with the console/chat message; local credentials never travel', async () => {
  saveProfile(TOKEN);
  expect(await maybeRunRemoteCommand(['task', 'approve', 'T-1'], options())).toBe(3);
  expect(err.join('')).toBe(`${STEP_UP_MESSAGE}\n`);
  expect(await maybeRunRemoteCommand(['task', 'approve', 'T-1', '--json'], options())).toBe(3);
  expect(JSON.parse(out.join(''))).toMatchObject({ ok: false, command: 'task approve', reason: 'step-up', message: STEP_UP_MESSAGE });
  for (const flag of ['--token', '--token-file', '--token-env', '--db']) {
    for (const args of [[flag, 'private-value'], [`${flag}=private-value`]]) {
      expect(await maybeRunRemoteCommand(['task', 'add', 'x', ...args], options())).toBe(2);
      expect(err.at(-1)).toContain(flag);
      expect(err.at(-1)).not.toContain('private-value');
    }
  }
  expect(sent).toHaveLength(0);
});

test('--steps contents are inlined under the argument as typed, capped at 256 KiB in total', async () => {
  saveProfile(TOKEN);
  writeFileSync(join(dir, 'plan.txt'), 'step one\n');
  expect(await maybeRunRemoteCommand(['flows', 'create', '--steps', 'plan.txt'], options())).toBe(0);
  expect(JSON.parse(String(sent[0]!.init.body))).toEqual({ argv: ['flows', 'create', '--steps', 'plan.txt'], files: { 'plan.txt': 'step one\n' } });
  writeFileSync(join(dir, 'big.txt'), 'x'.repeat(CLI_FILES_BYTES + 1));
  expect(await maybeRunRemoteCommand(['flows', 'create', '--steps', 'big.txt'], options())).toBe(2);
  expect(await maybeRunRemoteCommand(['flows', 'create', '--steps', 'missing.txt'], options())).toBe(2);
  expect(sent).toHaveLength(1);
});

test.each([
  ['flows', 'create', '--steps', 'my plan=a.txt'],
  ['flows', 'create', '--steps=my plan=a.txt'],
  ['flows', 'script', 'save', '--body', 'my plan=a.txt'],
  ['flows', 'script', 'save', '--body=my plan=a.txt'],
].map(argv => ({ argv })))('inlines UTF-8 file contents without changing $argv', async ({ argv }) => {
  saveProfile(TOKEN);
  writeFileSync(join(dir, 'my plan=a.txt'), 'é\n一\n');
  expect(await maybeRunRemoteCommand(argv, options())).toBe(0);
  expect(JSON.parse(String(sent[0]!.init.body))).toEqual({ argv, files: { 'my plan=a.txt': 'é\n一\n' } });
});

test('missing, non-file, invalid UTF-8 and empty file references are not sent in either form', async () => {
  saveProfile(TOKEN);
  writeFileSync(join(dir, 'invalid.txt'), Buffer.from([0xff]));
  for (const [command, flag] of [['flows create', '--steps'], ['flows script save', '--body']] as const) {
    for (const value of ['missing.txt', 'remote', 'invalid.txt', '']) {
      for (const args of [[flag, value], [`${flag}=${value}`]]) {
        expect(await maybeRunRemoteCommand([...command.split(' '), ...args], options()), args.join(' ')).toBe(2);
      }
    }
  }
  expect(sent).toHaveLength(0);
});

test('file limits sum UTF-8 bytes across both forms and count repeated paths once', async () => {
  saveProfile(TOKEN);
  writeFileSync(join(dir, 'one.txt'), 'é'.repeat(CLI_FILES_BYTES / 4));
  writeFileSync(join(dir, 'two.txt'), 'x'.repeat(CLI_FILES_BYTES / 2));
  const argv = ['flows', 'create', '--steps=one.txt', '--steps', 'two.txt', '--steps', 'one.txt'];
  expect(await maybeRunRemoteCommand(argv, options())).toBe(0);
  const files = JSON.parse(String(sent[0]!.init.body)).files as Record<string, string>;
  expect(Object.keys(files)).toEqual(['one.txt', 'two.txt']);
  expect(Object.values(files).reduce((bytes, value) => bytes + Buffer.byteLength(value), 0)).toBe(CLI_FILES_BYTES);
  writeFileSync(join(dir, 'two.txt'), 'x'.repeat(CLI_FILES_BYTES / 2 + 1));
  expect(await maybeRunRemoteCommand(argv, options())).toBe(2);
  expect(sent).toHaveLength(1);
});

test('a declared --file switch never reads the adjacent positional file', async () => {
  saveProfile(TOKEN);
  writeFileSync(join(dir, 'plan.txt'), 'do not inline');
  const argv = ['template', 'apply', '--file', 'plan.txt'];
  const modeOf: NonNullable<RemoteExecOptions['modeOf']> = () => ({ invocation: 'template apply', mode: 'yes', mutation: 'unkeyed', flags: [{ name: 'file', takesValue: false }] });
  expect(await maybeRunRemoteCommand(argv, options({ modeOf }))).toBe(0);
  expect(JSON.parse(String(sent[0]!.init.body))).toEqual({ argv, files: {} });
});

test.each(REMOTE_PATH_CASES)('client path inventory: $name', async ({ argv, row, policy }) => {
  saveProfile(TOKEN);
  writeFileSync(join(dir, PRIVATE_PATH), 'é\nscript or steps\n');
  const code = await maybeRunRemoteCommand(argv, options({ modeOf: () => row }));
  if (policy === 'inline') {
    expect(code).toBe(0);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(String(sent[0]!.init.body))).toEqual({ argv, files: { [PRIVATE_PATH]: 'é\nscript or steps\n' } });
  } else {
    expect(code).toBe(2);
    expect(sent).toHaveLength(0);
    expect(err.join('')).not.toContain(PRIVATE_PATH);
  }
});

test('literal JSON and flow URLs need no local file; stdin and forbidden paths never make a request', async () => {
  saveProfile(TOKEN);
  const modeOf: NonNullable<RemoteExecOptions['modeOf']> = argv => {
    const row = contractRow(argv);
    return row === null ? null : { ...row, mode: 'yes' };
  };
  for (const argv of [
    ['flows', 'create', '--steps', '{"steps":[]}'],
    ['flows', 'trigger', 'add', '42', '{"kind":"button"}'],
    ['flows', 'import', 'https://gist.github.com/alice/123'],
  ]) {
    expect(await maybeRunRemoteCommand(argv, options({ modeOf }))).toBe(0);
    expect(JSON.parse(String(sent.at(-1)!.init.body))).toEqual({ argv, files: {} });
  }
  const accepted = sent.length;
  for (const argv of [
    ['flows', 'create', '--steps=-'],
    ['flows', 'script', 'save', '--body', '-'],
    ['flows', 'trigger', 'add', '42', '-'],
    ['flows', 'import', PRIVATE_PATH],
    ['flows', 'script', 'save', '--body', PRIVATE_PATH, '--file', PRIVATE_PATH],
  ]) {
    expect(await maybeRunRemoteCommand(argv, options({ modeOf }))).toBe(2);
    expect(err.at(-1)).not.toContain(PRIVATE_PATH);
  }
  expect(sent).toHaveLength(accepted);
});

test('401, unreachable, redirected or malformed answers are reported once, never retried', async () => {
  saveProfile(TOKEN);
  reply = () => new Response(JSON.stringify({ ok: false, code: 'unauthenticated', message: 'This API token is not valid.' }), { status: 401 });
  expect(await maybeRunRemoteCommand(['status'], options())).toBe(3);
  expect(err.at(-1)).toBe('This API token is not valid.\n');
  reply = () => { throw new Error('ECONNREFUSED'); };
  expect(await maybeRunRemoteCommand(['task', 'add', 'x'], options())).toBe(1);
  expect(err.at(-1)).toContain('could not be confirmed');
  reply = () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example' } });
  expect(await maybeRunRemoteCommand(['status'], options())).toBe(1);
  reply = () => new Response('{"exitCode":"0"}', { status: 200 });
  expect(await maybeRunRemoteCommand(['status'], options())).toBe(1);
  expect(sent).toHaveLength(4);
});

test('task wait polls in slices of at most 25 seconds and prints the settled answer in the caller\'s format', async () => {
  saveProfile(TOKEN);
  const answers = [
    JSON.stringify({ ok: false, reason: 'timeout' }), JSON.stringify({ ok: false, reason: 'timeout' }), JSON.stringify({ ok: true, outcome: 'Ready' }),
  ];
  reply = () => { const body = JSON.parse(String(sent.at(-1)!.init.body)) as { argv: string[] }; return answer(0, body.argv.includes('--json') ? `${answers.shift()}\n` : 'T-1 is Ready.\n')(); };
  expect(await maybeRunRemoteCommand(['task', 'wait', 'T-1'], options({ sleep: async () => {} }))).toBe(0);
  const argvs = sent.map(one => (JSON.parse(String(one.init.body)) as { argv: string[] }).argv);
  expect(argvs.slice(0, 3)).toEqual(Array(3).fill(['task', 'wait', 'T-1', '--json', '--timeout', '25']));
  expect(argvs[3]).toEqual(['task', 'wait', 'T-1', '--timeout', '0']);
  expect(out.join('')).toBe('T-1 is Ready.\n');
});

test('the contract decides: rows without a remote mark run here', () => {
  expect(contractRow(['task', 'show', 'T-1'])?.invocation).toBe('task show');
  expect(contractRow(['repos', 'add', '/repo/a'])?.invocation).toBe('repos add');
  expect(contractRow(['flows', 'script', 'save', '--file=plan.txt'])?.invocation).toBe('flows script save');
  expect(contractRow(['serve'])?.mode).toBe('no');
  expect(contractRow(['nonsense'])).toBeNull();
});
