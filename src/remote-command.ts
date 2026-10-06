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
const LOCAL_ONLY_FLAGS = new Set(['--token', '--token-file', '--token-env', '--db']);

/** Inspect both --name value and --name=value without ever returning a credential's value. */
export function localOnlyFlag(argv: readonly string[]): string | undefined {
  return argv.map(one => one.split('=', 1)[0]!).find(name => LOCAL_ONLY_FLAGS.has(name));
}

/** File values stay exactly as typed, including spaces and equals signs. Both sides use the same flag arity. */
export function fileArguments(argv: readonly string[], row: RemoteCommand): string[] | { problem: string } {
  const paths: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!, equals = argument.indexOf('=');
    const name = equals < 0 ? argument : argument.slice(0, equals);
    if (name !== '--steps' && name !== '--file') continue;
    const takesValue = row.flags?.find(flag => flag.name === name.slice(2))?.takesValue;
    if (name === '--file' && takesValue === false) {
      if (equals >= 0) return { problem: '--file does not take a value for this command.' };
      continue;
    }
    const value = equals < 0 ? argv[index + 1] : argument.slice(equals + 1);
    if (value === undefined || equals < 0 && value.startsWith('--')) {
      // Legacy rows may omit flag details. A bare --file can be a switch; --steps always needs a path.
      if (name === '--file' && takesValue !== true && equals < 0) continue;
      return { problem: `${name} needs a file path.` };
    }
    if (value === '') return { problem: `${name} needs a file path.` };
    paths.push(value);
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
