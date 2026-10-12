import { writeFileSync } from 'node:fs';
await import('../../../dist/storage-sweep-child.js');
process.send({ ready: true, pid: process.pid }, () => {
  if (process.argv[2] === 'blocked') {
    writeFileSync(process.argv[3], 'blocked');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
});
