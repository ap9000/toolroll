import { fork } from 'node:child_process';
// The stdout pipe stays open until both this parent and the blocked sweep child die.
const child = fork(new URL('./child.mjs', import.meta.url), ['blocked', process.argv[2]], {
  detached: true, stdio: ['ignore', process.stdout, 'ignore', 'ipc'],
});
child.once('message', value => process.send(value));
process.on('message', () => process.exit(0));
