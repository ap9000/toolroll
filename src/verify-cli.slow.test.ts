/** Real PTY lifecycle contract. Requires the built checkout; never builds or calls a real model.
 * Kept in slow tier until measured (even the empty console can exceed the fast tier's ten-second budget). */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
// @ts-expect-error shared ESM environment helper
import { isolatedEnvironment, assertIsolated } from '../scripts/isolated-env.mjs';

test('built checkout opens first run, new-task composer and help in a real PTY', async () => {
  const root = mkdtempSync(join(tmpdir(), 'verify-smoke-'));
  const out = resolve('evidence', `verify-test-${process.pid}-${Date.now()}`);
  mkdirSync(out, { recursive: true });
  const world = isolatedEnvironment({ root });
  assertIsolated(world.env, { root });
  const child = spawn(process.execPath, [resolve('scripts/verify.mjs'), '--features', 'welcome,new-task,help', '--out', out],
    { env: world.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
  try {
    // Ceiling for a starved CI runner; readiness itself is checked by screen facts in verify.mjs.
    const code = await new Promise<number | null>((done, failed) => {
      const timer = setTimeout(() => { child.kill('SIGTERM'); failed(new Error(`verification did not finish: ${output}`)); }, 90_000);
      child.once('error', error => { clearTimeout(timer); failed(error); });
      child.once('exit', value => { clearTimeout(timer); done(value); });
    });
    expect(code, output).toBe(0);
    const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
    expect(report.ok).toBe(true);
    expect(report.features.map((feature: { id: string }) => feature.id)).toEqual(['welcome', 'new-task', 'help']);
    expect(report.features.every((feature: { status: string; excerpt: string }) => feature.status === 'PASS' && feature.excerpt.length > 0)).toBe(true);
    expect(report.sessions[0].outbound.status).toBe('PASS');
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise<void>(done => child.once('exit', () => done())); }
    rmSync(root, { recursive: true, force: true });
    // Evidence intentionally retained under evidence/, ignored by Git.
  }
}, 110_000);
