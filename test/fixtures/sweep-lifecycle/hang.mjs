// Synthetic sweep: begin a real quarantine deletion, then ignore TERM with a descendant in the same group.
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import { quarantine, deleteQuarantine } from '../../../dist/sweep-quarantine.js';
process.on('SIGTERM', () => {});
process.on('message', () => {});
const descendant = fork(new URL('./idle.mjs', import.meta.url), [], { stdio: ['ignore', process.stdout, 'ignore', 'ipc'] });
await once(descendant, 'message');
const entry = quarantine(process.argv[2], null);
await deleteQuarantine(entry, async path => {
  rmSync(path, { recursive: true, force: true });
  process.send({ ready: true, descendant: descendant.pid });
  await new Promise(() => {});
});
