import { COMMAND_GUIDE, type CommandFlag } from './surface.js';

export type RemoteMode = 'yes' | 'no' | 'step-up';
export type RemoteCommand = {
  invocation: string;
  mode: RemoteMode;
  mutation: string;
  flags?: readonly Pick<CommandFlag, 'name' | 'takesValue'>[];
};
export type RemoteCommandLookup = (argv: readonly string[]) => RemoteCommand | null;
export const STEP_UP_MESSAGE = 'approve in the console or chat';

type PathPolicy = 'inline' | 'refuse';
export type RemotePathArgument = {
  invocation: string;
  argument: { flag: string } | { position: number; name: string; rest?: true };
  policy: PathPolicy;
  literal?: 'json' | 'url';
};

/**
 * Filesystem arguments audited against operate.ts, flows-cli.ts and cli.ts's local dispatchers.
 * Keep this inventory command-specific: --file runs a project executable for scripts, but is a
 * boolean for template apply; --to is a directory for link and a date for ledger export.
 * Project selectors (--repo), scope globs (--touches/--paths) and saved IDs are not input files;
 * their authority belongs to runOperateAs. Local installers' explicit destinations are refused.
 * '*' is reserved for the credentials/database and cli.ts's output redirection, on every command.
 */
export const REMOTE_PATH_ARGUMENTS: readonly RemotePathArgument[] = [
  ...['--token', '--token-file', '--token-env', '--db', '-o', '--output'].map(flag => ({ invocation: '*', argument: { flag }, policy: 'refuse' as const })),
  { invocation: 'flows create', argument: { flag: '--steps' }, policy: 'inline', literal: 'json' },
  { invocation: 'flows edit', argument: { flag: '--steps' }, policy: 'inline', literal: 'json' },
  { invocation: 'flows script save', argument: { flag: '--body' }, policy: 'inline' },
  { invocation: 'flows script save', argument: { flag: '--file' }, policy: 'refuse' },
  { invocation: 'flows export', argument: { flag: '--out' }, policy: 'refuse' },
  // Import stats the original path before readInput. Inlining alone cannot prevent that server read.
  { invocation: 'flows import', argument: { position: 0, name: 'file' }, policy: 'refuse', literal: 'url' },
  { invocation: 'flows trigger add', argument: { position: 1, name: 'trigger' }, policy: 'inline', literal: 'json' },
  { invocation: 'task evidence', argument: { flag: '--out' }, policy: 'refuse' },
  { invocation: 'ledger export', argument: { flag: '--out' }, policy: 'refuse' },
  { invocation: 'export', argument: { flag: '--out' }, policy: 'refuse' },
  { invocation: 'restore', argument: { position: 0, name: 'backup file' }, policy: 'refuse' },
  { invocation: 'storage discard', argument: { position: 0, name: 'checkout path' }, policy: 'refuse' },
  { invocation: 'keys set', argument: { flag: '--key-file' }, policy: 'refuse' },
  { invocation: 'daemon', argument: { flag: '--bin' }, policy: 'refuse' },
  ...['build', 'tick', 'reconcile', 'watch', 'serve', 'up', 'daemon', 'task resume'].map(invocation => ({ invocation, argument: { flag: '--pool' }, policy: 'refuse' as const })),
  ...['serve', 'up'].map(invocation => ({ invocation, argument: { flag: '--project-root' }, policy: 'refuse' as const })),
  { invocation: 'skills install', argument: { flag: '--dir' }, policy: 'refuse' },
  { invocation: 'skills install', argument: { flag: '--repo' }, policy: 'refuse' },
  { invocation: 'onboard', argument: { flag: '--repo' }, policy: 'refuse' },
  { invocation: 'repos add-from-github', argument: { flag: '--root' }, policy: 'refuse' },
  ...['link', 'unlink'].map(invocation => ({ invocation, argument: { flag: '--to' }, policy: 'refuse' as const })),
  ...['repos add', 'repos remove', 'pulls', 'graph', ''].map(invocation => ({ invocation, argument: { position: 0, name: 'path', rest: true as const }, policy: 'refuse' as const })),
  { invocation: 'project use', argument: { position: 0, name: 'checkout path' }, policy: 'refuse' },
  // These local HTTP clients read prompts themselves; they do not consume runOperateAs's files map.
  ...['session start', 'session send'].map(invocation => ({ invocation, argument: { flag: '--file' }, policy: 'refuse' as const })),
];

type FileProblem = { problem: string; code: 'local-only-flag' | 'server-path' | 'missing-file' | 'invalid-arguments' };

/**
 * Parse once using declared arity, so a flag's value cannot be mistaken for another flag or a
 * file positional. Unknown arity fails closed. File keys and argv stay exactly as typed.
 * All failures describe the argument slot, never a supplied path, credential or other value.
 */
export function fileArguments(argv: readonly string[], row: RemoteCommand): string[] | FileProblem {
  const paths: string[] = [];
  const rules = REMOTE_PATH_ARGUMENTS.filter(one => one.invocation === '*' || one.invocation === row.invocation);
  const words = row.invocation === '' ? [] : row.invocation.split(' ');
  if (!words.every((word, index) => argv[index] === word)) return { problem: 'The command arguments do not match its invocation.', code: 'invalid-arguments' };
  const inspect = (rule: RemotePathArgument, value: string | undefined): FileProblem | undefined => {
    const label = 'flag' in rule.argument ? rule.argument.flag : `${row.invocation} ${rule.argument.name} argument`;
    if (rule.invocation === '*' && 'flag' in rule.argument && rule.argument.flag !== '-o' && rule.argument.flag !== '--output') {
      return { problem: `${label} cannot be used remotely. Sign in with your saved API token.`, code: 'local-only-flag' };
    }
    if (value !== undefined && (rule.literal === 'json' && /^[{[]/.test(value.trim()) || rule.literal === 'url' && /^[a-z][a-z0-9+.-]*:\/\//i.test(value))) return;
    if (rule.policy === 'refuse') return { problem: `${label} cannot use a server path remotely. Use --local to run it here.`, code: 'server-path' };
    if (value === undefined || value === '') return { problem: `${label} needs a file path.`, code: 'missing-file' };
    // '-' would otherwise read the server's stdin (or a client file literally named '-'). Never prompt.
    if (value === '-') return { problem: `${label} needs a file instead of stdin for a remote command.`, code: 'server-path' };
    paths.push(value);
  };
  let position = 0;
  for (let index = words.length; index < argv.length; index++) {
    const argument = argv[index]!, equals = argument.indexOf('=');
    const name = equals < 0 ? argument : argument.slice(0, equals);
    if (argument.startsWith('--') || name === '-o' || name === '-h') {
      const rule = rules.find(one => 'flag' in one.argument && one.argument.flag === name);
      const takesValue = rule !== undefined ? true : name === '-h' || name === '--help' || name === '--json' ? false : row.flags?.find(flag => `--${flag.name}` === name)?.takesValue;
      if (takesValue === undefined) return { problem: 'This option is not declared for remote use. Use --local to run it here.', code: 'invalid-arguments' };
      if (!takesValue) {
        if (equals >= 0) return { problem: 'This command switch does not take a value.', code: 'invalid-arguments' };
        continue;
      }
      const next = equals < 0 ? argv[index + 1] : argument.slice(equals + 1);
      const value = equals < 0 && next?.startsWith('--') ? undefined : next;
      if (rule !== undefined) {
        const problem = inspect(rule, value);
        if (problem !== undefined) return problem;
      }
      if (value === undefined) return { problem: 'A command option needs a value.', code: 'invalid-arguments' };
      if (equals < 0) index++;
    } else {
      const rule = rules.find(one => 'position' in one.argument && (one.argument.position === position || one.argument.rest && position >= one.argument.position));
      if (rule !== undefined) {
        const problem = inspect(rule, argument);
        if (problem !== undefined) return problem;
      }
      position++;
    }
  }
  return paths;
}

/** The longest declared invocation named by the leading words. Missing remote metadata means local only. */
export const contractRow: RemoteCommandLookup = argv => {
  const words: string[] = [];
  for (const one of argv) { if (one.startsWith('-')) break; words.push(one); }
  let best: RemoteCommand | null = null;
  for (const row of COMMAND_GUIDE) {
    const parts = row.invocation.split(' ');
    if (parts.length > words.length || !parts.every((part, index) => words[index] === part)) continue;
    if (best !== null && best.invocation.split(' ').length >= parts.length) continue;
    const remote = (row as { remote?: unknown }).remote;
    best = { invocation: row.invocation, mode: remote === 'yes' || remote === 'step-up' ? remote : 'no', mutation: row.mutation, flags: row.flags ?? [] };
  }
  return best;
};
