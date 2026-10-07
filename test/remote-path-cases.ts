import { contractRow, REMOTE_PATH_ARGUMENTS, type RemoteCommand } from '../src/remote-command.js';

export const PRIVATE_PATH = 'private file=a.txt';

/** Exercise every inventory entry through both transport boundaries, including otherwise local commands. */
export const REMOTE_PATH_CASES = REMOTE_PATH_ARGUMENTS.flatMap(rule => {
  const invocation = rule.invocation === '*' ? 'task add' : rule.invocation;
  const words = invocation === '' ? [] : invocation.split(' ');
  const row: RemoteCommand = { ...contractRow(words), invocation, mode: 'yes', mutation: 'unkeyed' };
  const argument = rule.argument;
  const variants = 'flag' in argument
    ? [[argument.flag, PRIVATE_PATH], [`${argument.flag}=${PRIVATE_PATH}`]]
    : [[...Array<string>(argument.position).fill('42'), PRIVATE_PATH]];
  return variants.map((args, index) => ({
    name: `${invocation || 'scan'} ${'flag' in argument ? argument.flag : `positional ${argument.position}`} ${index === 0 ? 'separate' : 'equals'}`,
    argv: [...words, ...args], row, policy: rule.policy,
  }));
});
