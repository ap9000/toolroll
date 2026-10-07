import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { runHealthCommand } from './health-cli.js';

test('health has actionable missing-connection, permission, old-server and unexpected-response failures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'so-health-cli-')), profileFile = join(dir, 'profile.json'), lines: string[] = [];
  const write = (line: string) => lines.push(line);
  try {
    expect(await runHealthCommand([], write, { profileFile })).toBe(2);
    expect(lines.pop()).toContain('Connect to the server first');
    writeFileSync(profileFile, JSON.stringify({ version: 1, active: 'test', profiles: { test: { origin: 'http://127.0.0.1:43210', account: 'synthetic', token: 'synthetic' } } }), { mode: 0o600 });
    for (const [status, message] of [[403, 'instance operator'], [404, 'Update the server'], [503, 'unavailable']] as const) {
      expect(await runHealthCommand(['--json'], write, { profileFile, fetch: async () => new Response('', { status }) })).toBe(1);
      expect(JSON.parse(lines.pop()!).message).toContain(message);
    }
    expect(await runHealthCommand([], write, { profileFile, fetch: async () => new Response('<html>Sign in</html>', { headers: { 'content-type': 'text/html' } }) })).toBe(1);
    expect(lines.pop()).toContain('unexpected health response');
    expect(await runHealthCommand(['--json'], write, { profileFile, fetch: async () => Response.json({ version: 1 }) })).toBe(1);
    expect(JSON.parse(lines.pop()!).message).toContain('unexpected health response');
    expect(await runHealthCommand(['--db', '/should-not-open'], write, { profileFile })).toBe(2);
    expect(await runHealthCommand(['--profile'], write, { profileFile })).toBe(2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
