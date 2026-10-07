import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maybeRunTeamCommand, type TeamCliOptions } from './team-cli.js';
import type { TeamRequest, TeamResponse, TeamSnapshot } from './team-contract.js';

let dir: string, profileFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'so-team-cli-budget-')); profileFile = join(dir, 'profiles.json');
  writeFileSync(profileFile, JSON.stringify({ version: 1, active: 'default', profiles: { default: { origin: 'https://console.example', account: 'alex', token: 'test-password' } } }), { mode: 0o600 });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });
const snapshot = (title = 'Project plans'): TeamSnapshot => ({
  leads: [], conversations: [], selected: { id: 'conversation', leadId: 'lead', title, visibility: 'team', projects: ['/repo'], revision: 1, threadId: 1, createdBy: 'alex', follow: false },
  participants: [], messages: [], canManage: true, canSend: true, cursor: 1, truncated: false, projects: ['/repo'], accounts: ['alex'],
  chatAuthorization: { enabled: true, provider: 'claude-subscription', model: 'default', dailyTurns: 50, weeklyCeilingUsd: null, conversationCeilingUsd: null, termsDigest: 'terms' },
});
const good = (title?: string) => Response.json({ version: 1, ok: true, code: 'ok', message: 'Conversation ready.', snapshot: snapshot(title) } satisfies TeamResponse);
const limited = (retryAfter: string | null) => Response.json({ version: 1, ok: false, code: 'rate-limited', message: 'Try again shortly.' }, { status: 429, headers: retryAfter === null ? {} : { 'retry-after': retryAfter } });
const run = (args: string[], options: TeamCliOptions, output: string[] = []) => maybeRunTeamCommand(args, line => output.push(line), { profileFile, ...options });

test.each([['7', 7000], ['invalid', 5000], [null, 5000], ['-3', 5000], ['0', 1000], ['99999999', 300000]] as const)('follower waits for Retry-After %s and resumes only show polls', async (header, expected) => {
  const controller = new AbortController(), waits: number[] = [], calls: TeamRequest[] = [], output: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
    calls.push(JSON.parse(String(options?.body)) as TeamRequest);
    return calls.length === 2 ? limited(header) : good(calls.length >= 3 ? 'Updated plans' : undefined);
  });
  const result = await run(['chat', '--conversation', 'conversation', '--follow', '--json'], { signal: controller.signal, fetch: fetcher,
    sleep: async (ms, signal) => { waits.push(ms); expect(signal.aborted).toBe(false); if (waits.length === 3) controller.abort(); } }, output);
  expect(result).toBe(0);
  expect(waits).toEqual([2000, expected, 2000]);
  expect(calls.map(call => call.operation)).toEqual(['show', 'show', 'show']);
  expect(output.map(line => JSON.parse(line).code)).not.toContain('rate-limited');
  expect(output.join('\n')).toContain('Updated plans');
});

test('HTTP-date Retry-After uses the same bounded delay', async () => {
  const at = Date.parse('2026-10-07T19:00:00Z'); vi.spyOn(Date, 'now').mockReturnValue(at);
  const controller = new AbortController(), waits: number[] = []; let calls = 0;
  expect(await run(['chat', '--conversation', 'conversation', '--follow'], { signal: controller.signal, fetch: async () => ++calls === 2 ? limited(new Date(at + 9000).toUTCString()) : good(),
    sleep: async ms => { waits.push(ms); if (waits.length === 3) controller.abort(); } })).toBe(0);
  expect(waits).toEqual([2000, 9000, 2000]);
});

test('cancelling during backoff immediately ends the follower without another request', async () => {
  const controller = new AbortController(); let sleeping!: () => void;
  const backoff = new Promise<void>(resolve => { sleeping = resolve; });
  let calls = 0;
  const running = run(['chat', '--conversation', 'conversation', '--follow'], { signal: controller.signal, fetch: async () => ++calls === 1 ? good() : limited('60'),
    sleep: async (ms, signal) => { if (ms === 2000) return; sleeping(); await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } });
  // If the bug returns before sleeping, fail deterministically rather than hanging on an unresolved event.
  expect(await Promise.race([backoff.then(() => 'sleeping'), running.then(() => 'exited')])).toBe('sleeping');
  controller.abort();
  expect(await running).toBe(0); expect(calls).toBe(2);
});

test('cancelling an in-flight follower poll aborts its fetch without an error or retry', async () => {
  let polling!: () => void; const started = new Promise<void>(resolve => { polling = resolve; });
  const controller = new AbortController(); let calls = 0;
  const running = run(['chat', '--conversation', 'conversation', '--follow'], { signal: controller.signal, sleep: async () => {}, fetch: async (_url, options) => {
    if (++calls === 1) return good(); polling();
    return new Promise<Response>((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  await started; controller.abort(); expect(await running).toBe(0); expect(calls).toBe(2);
});

test.each(['limited', 'lost'] as const)('%s mutation delivery is never replayed', async kind => {
  const calls: string[] = [], output: string[] = [], sleep = vi.fn(async () => {});
  const result = await run(['chat', '--conversation', 'conversation', '--say', 'Please review the saved plan', '--json'], { sleep, fetch: async (_url, options) => {
    const request = JSON.parse(String(options?.body)) as TeamRequest; calls.push(request.operation);
    if (request.operation === 'show') return good();
    if (kind === 'lost') throw Error('connection lost');
    return limited('7');
  } }, output);
  expect(result).toBe(1); expect(calls).toEqual(['show', 'show', 'send']); expect(sleep).not.toHaveBeenCalled();
  expect(JSON.parse(output.at(-1)!).code).toBe(kind === 'lost' ? 'delivery-unconfirmed' : 'rate-limited');
  expect(JSON.parse(output.at(-1)!).result).toMatchObject({ operation: 'send', conversationId: 'conversation', requestId: expect.stringMatching(/^[0-9a-f]{32}$/) });
});

test('a one-off read returns 429 without starting follower retries', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => limited('7')), sleep = vi.fn(async () => {});
  expect(await run(['conversation', 'show', '--conversation', 'conversation'], { fetch: fetcher, sleep })).toBe(1);
  expect(fetcher).toHaveBeenCalledTimes(1); expect(sleep).not.toHaveBeenCalled();
});


test('a failure body cannot invent retry permission without HTTP 429', async () => {
  let calls = 0; const waits: number[] = [], output: string[] = [];
  expect(await run(['chat', '--conversation', 'conversation', '--follow', '--json'], { fetch: async () => ++calls === 1 ? good() : Response.json({ version: 1, ok: false, code: 'forbidden', message: 'Access ended.', retryAfterMs: 1000 }),
    sleep: async ms => { waits.push(ms); if (waits.length > 1) throw Error('Must not retry'); } }, output)).toBe(1);
  expect(calls).toBe(2); expect(waits).toEqual([2000]); expect(JSON.parse(output.at(-1)!).code).toBe('forbidden');
});
