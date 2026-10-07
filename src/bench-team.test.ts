import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';
const exec = promisify(execFile);

test('team benchmark runs tiny load with live views, remote CLI and progress writers, then removes its scratch database', async () => {
  mkdirSync('evidence', { recursive: true });
  const before = readdirSync('evidence').filter(name => name.startsWith('.bench-team-'));
  const guard = mkdtempSync(join(tmpdir(), 'so-bench-guard-')), forbidden = join(guard, 'orders.db');
  writeFileSync(forbidden, 'synthetic database selector: never open this file');
  try {
    const { stdout } = await exec(process.execPath, ['scripts/bench-team.mjs', '--engineers', '1', '--agents', '1', '--seconds', '1', '--tasks', '10', '--stages', 'steady'], { timeout: 60_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, TOOLROLL_DB: forbidden, STANDING_ORDERS_DB: forbidden, XDG_CONFIG_HOME: guard } });
    const report = JSON.parse(stdout), stage = report.stages[0];
    expect(report).toMatchObject({ version: 1, synthetic: true, scratchRemoved: true, options: { engineers: 1, agents: 1 } });
    expect(stage).toMatchObject({ commandFailures: 0, transportFailures: 0, metricsPresent: true, health: { streams: { open: 1 } }, writer: { written: 1, failed: 0 } });
    expect(stage.statuses['200']).toBe(1);
    expect(stage.health.eventLoop.count).toBeGreaterThan(0);
    expect(readFileSync(forbidden, 'utf8')).toBe('synthetic database selector: never open this file');
    expect(readdirSync(guard)).toEqual(['orders.db']);
    expect(readdirSync('evidence').filter(name => name.startsWith('.bench-team-'))).toEqual(before);
  } finally { rmSync(guard, { recursive: true, force: true }); }
});

test('benchmark rejects attempts to choose a live database or address before starting a server', async () => {
  for (const flag of ['--db', '--url']) await expect(exec(process.execPath, ['scripts/bench-team.mjs', flag, 'forbidden'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('No database or URL is accepted') });
});
