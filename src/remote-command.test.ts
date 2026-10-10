import { expect, test } from 'vitest';
import { contractRow, fileArguments, REMOTE_PATH_ARGUMENTS, type RemoteCommand } from './remote-command.js';
import { PRIVATE_PATH, REMOTE_PATH_CASES } from '../test/remote-path-cases.js';

const inspect = (argv: string[]) => {
  const row = contractRow(argv);
  if (row === null) throw new Error('No command row');
  return fileArguments(argv, row);
};

test('the inventory includes all audited file, destination, credential and executable arguments', () => {
  expect(REMOTE_PATH_ARGUMENTS.map(rule => `${rule.invocation || 'scan'} ${'flag' in rule.argument ? rule.argument.flag : `@${rule.argument.position}`} ${rule.policy}${rule.literal ? `/${rule.literal}` : ''}`)).toEqual([
    '* --token refuse', '* --token-file refuse', '* --token-env refuse', '* --db refuse', '* -o refuse', '* --output refuse',
    'flows create --steps inline/json', 'flows edit --steps inline/json', 'flows script save --body inline',
    'flows script save --file refuse', 'flows export --out refuse', 'flows import @0 refuse/url', 'flows trigger add @1 inline/json',
    'task evidence --out refuse', 'ledger export --out refuse', 'export --out refuse', 'restore @0 refuse',
    'storage discard @0 refuse', 'keys set --key-file refuse', 'daemon --bin refuse',
    'build --pool refuse', 'tick --pool refuse', 'reconcile --pool refuse', 'watch --pool refuse', 'serve --pool refuse',
    'up --pool refuse', 'daemon --pool refuse', 'task resume --pool refuse', 'serve --project-root refuse', 'up --project-root refuse',
    'skills install --dir refuse', 'skills install --repo refuse', 'onboard --repo refuse', 'repos add-from-github --root refuse',
    'link --to refuse', 'unlink --to refuse', 'repos add @0 refuse', 'repos remove @0 refuse', 'pulls @0 refuse',
    'graph @0 refuse', 'scan @0 refuse', 'project use @0 refuse',
  ]);
});

test.each(REMOTE_PATH_CASES)('$name follows its path policy without returning private values in errors', ({ argv, row, policy }) => {
  const result = fileArguments(argv, row);
  if (policy === 'inline') expect(result).toEqual([PRIVATE_PATH]);
  else {
    expect(result).toMatchObject({ problem: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain(PRIVATE_PATH);
  }
});

test.each([
  ['flows', 'create', '--steps', ' {"steps":[]}'],
  ['flows', 'edit', '42', '--steps= [ ]'],
  ['flows', 'trigger', 'add', '42', ' {"kind":"button"}'],
  ['flows', 'import', 'https://gist.github.com/alice/123', '--repo', '/repo/a'],
  // These cannot become filesystem reads either: command validation owns invalid JSON/URL errors.
  ['flows', 'create', '--steps={invalid'],
  ['flows', 'import', 'file:///private/local'],
].map(argv => ({ argv })))('keeps the command\'s literal form: $argv', ({ argv }) => {
  expect(inspect(argv)).toEqual([]);
});

test('flags consume their values, boolean --file stays boolean, and positions count only actual positionals', () => {
  expect(inspect(['flows', 'trigger', 'add', '--as', 'alice', '42', '--json', PRIVATE_PATH])).toEqual([PRIVATE_PATH]);
  expect(inspect(['flows', 'trigger', 'add', PRIVATE_PATH, '--as=alice', '{"kind":"button"}'])).toEqual([]);
  expect(inspect(['flows', 'script', 'save', '--about=--file=private', '--body=--out=private'])).toEqual(['--out=private']);
  // This legacy command has no guide row yet; use the same declared-arity seam as transport tests.
  const template: RemoteCommand = { invocation: 'template apply', mode: 'yes', mutation: 'unkeyed', flags: [{ name: 'file', takesValue: false }] };
  expect(fileArguments(['template', 'apply', '--file', PRIVATE_PATH], template)).toEqual([]);
  expect(fileArguments(['template', 'apply', '--file=private'], template)).toMatchObject({ code: 'invalid-arguments' });
  expect(inspect(['task', 'add', PRIVATE_PATH, '--repo', '/repo/a'])).toEqual([]);
  // --to is a date for ledger export, not link's destination.
  const row: RemoteCommand = { invocation: 'ledger export', mode: 'yes', mutation: 'none', flags: [{ name: 'to', takesValue: true }] };
  expect(fileArguments(['ledger', 'export', '--to', '2026-10-01'], row)).toEqual([]);
});

test('--output is -o spelled long: a server path in every form, never echoed', () => {
  for (const args of [['-o', PRIVATE_PATH], ['--output', PRIVATE_PATH], [`--output=${PRIVATE_PATH}`], ['--json', '--output', PRIVATE_PATH]]) {
    const result = inspect(['task', 'show', '42', ...args]);
    expect(result).toMatchObject({ code: 'server-path' });
    expect(JSON.stringify(result)).not.toContain(PRIVATE_PATH);
  }
});

test('unclassified flags and ambiguous positionals fail closed without echoing values', () => {
  for (const argv of [
    ['flows', 'trigger', 'add', '--unknown', '42', PRIVATE_PATH],
    ['flows', 'script', 'save', '--steps', PRIVATE_PATH],
    ['task', 'add', 'title', '--file', PRIVATE_PATH],
    ['flows', 'import', '--unknown=value', 'https://gist.github.com/alice/123', PRIVATE_PATH],
  ]) {
    expect(inspect(argv)).toMatchObject({ code: 'invalid-arguments' });
    expect(JSON.stringify(inspect(argv))).not.toContain(PRIVATE_PATH);
  }
});

test('all inline flags reject missing and empty values and server stdin, including equals forms', () => {
  for (const rule of REMOTE_PATH_ARGUMENTS.filter(rule => rule.policy === 'inline')) {
    if (!('flag' in rule.argument)) continue;
    for (const args of [[rule.argument.flag], [rule.argument.flag, '--json'], [rule.argument.flag, ''], [`${rule.argument.flag}=`], [rule.argument.flag, '-'], [`${rule.argument.flag}=-`]]) {
      expect(inspect([...rule.invocation.split(' '), ...args])).toMatchObject({ problem: expect.any(String) });
    }
  }
  expect(inspect(['flows', 'trigger', 'add', '42', '-'])).toMatchObject({ code: 'server-path' });
  expect(inspect(['flows', 'trigger', 'add', '42', ''])).toMatchObject({ code: 'missing-file' });
});

test('inline values remain exact and all duplicate occurrences need contents', () => {
  expect(inspect(['flows', 'create', '--steps', PRIVATE_PATH, '--steps=other=path.txt', '--steps', PRIVATE_PATH])).toEqual([PRIVATE_PATH, 'other=path.txt', PRIVATE_PATH]);
  // JSON is special only for readJson consumers; script bodies always name input files.
  expect(inspect(['flows', 'script', 'save', '--body={script}'])).toEqual(['{script}']);
  // Import has a pre-read stat, so even JSON-looking names and stdin must be refused.
  for (const value of ['{"steps":[]}', '-', '', 'https:/local-file', './https://local-file']) {
    expect(inspect(['flows', 'import', value])).toMatchObject({ code: 'server-path' });
  }
});
