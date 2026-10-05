import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from './store.js';
import { addApprover } from './scope.js';
import { createDecisionServer } from './serve.js';
import * as workIndex from './work-index.js';
import type { BrowserWorkspace } from './browser-workspace.js';

const NOW = new Date('2026-09-21T12:00:00.000Z');
const CHAT = '/chat?format=workspace';
let store: Store, server: Server, directory: string, repo: string, base: string, token: string, now: Date;
let admitted: string[];
const provider = vi.fn(async () => { throw new Error('A metadata refresh must not call a provider'); });

beforeEach(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'so-workspace-refresh-')));
  repo = join(directory, 'repo'); mkdirSync(repo);
  admitted = [repo]; now = NOW;
  store = openStore(':memory:');
  const account = addApprover(store, 'alex', NOW);
  if (!account.ok) throw new Error('account fixture');
  token = account.token;
  server = createDecisionServer({ store, evidenceRoot: join(directory, 'evidence'), clock: () => now,
    projectRoots: [directory], currentRepos: () => admitted,
    chatEnv: {}, chatFetcher: provider as typeof fetch, subscriptionChatRunner: provider,
    // Never the machine's real claude, codex, gh or git grep: an instant, fixed answer.
    connectionProbe: signedOut, firstTaskRunner: quietRepo });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server fixture');
  base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  expect(provider).not.toHaveBeenCalled();
  vi.restoreAllMocks(); provider.mockClear();
  store.close(); rmSync(directory, { recursive: true, force: true });
});

const signedOut = async (file: string) => ({ code: 1, stdout: file === 'codex' ? 'Not logged in\n' : JSON.stringify({ loggedIn: false }), stderr: '', timedOut: false, notFound: false });
const quietRepo = async () => ({ code: 1, stdout: '', stderr: '', timedOut: false, notFound: false });

async function login(): Promise<string> {
  const response = await fetch(base + '/login', { method: 'POST', redirect: 'manual',
    body: new URLSearchParams({ name: 'alex', token }) });
  expect(response.status).toBe(303);
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  await settle(cookie);
  return cookie;
}
/** The first render starts the sign-in check in the background, and its answer is part of the page: let it land, so
 * the validator a test takes next is not changed by that answer arriving (it arrives at once in CI, later here). */
async function settle(cookie: string): Promise<void> {
  let last: string | null = null;
  for (let attempt = 0; attempt < 50; attempt++) {
    const tag = (await read(cookie)).headers.get('etag');
    if (tag !== null && tag === last) return;
    last = tag;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function read(cookie: string, etag?: string, path = CHAT): Promise<Response> {
  return fetch(base + path, { redirect: 'manual', headers: { cookie, ...(etag ? { 'if-none-match': etag } : {}) } });
}
async function fresh(cookie: string, path = CHAT): Promise<{ etag: string; workspace: BrowserWorkspace }> {
  const response = await read(cookie, undefined, path);
  expect(response.status).toBe(200);
  const etag = response.headers.get('etag'); expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
  return { etag: etag!, workspace: await response.json() as BrowserWorkspace };
}

test('authenticated unchanged refresh returns an empty 304 before querying or projecting work', async () => {
  const cookie = await login();
  const query = vi.spyOn(workIndex, 'workIndexPage');
  const initial = await fresh(cookie);
  expect(initial.workspace.user).toBe('alex'); expect(query).toHaveBeenCalled(); query.mockClear();
  const unchanged = await read(cookie, initial.etag);
  expect(unchanged.status).toBe(304);
  expect(unchanged.headers.get('etag')).toBe(initial.etag);
  expect(unchanged.headers.get('cache-control')).toContain('no-store');
  expect(await unchanged.text()).toBe(''); expect(query).not.toHaveBeenCalled();
  // A forced/manual read omits the validator and still executes a fresh read.
  expect((await read(cookie)).status).toBe(200); expect(query).toHaveBeenCalled();
});

test('saved edits invalidate the response and exact clock expiry cannot reuse it', async () => {
  const cookie = await login(); const initial = await fresh(cookie);
  store.createTask({ id: 'saved-work', title: 'Review the saved change' }, now);
  store.placeTask(store.lookupRef('saved-work')!.id, repo);
  const changed = await read(cookie, initial.etag);
  expect(changed.status).toBe(200);
  const changedTag = changed.headers.get('etag')!; expect(changedTag).not.toBe(initial.etag);
  const saved = (await changed.json() as BrowserWorkspace).crew.find(item => item.id === 'saved-work');
  expect(saved?.updatedAt).toBe(NOW.toISOString());
  expect((await read(cookie, changedTag)).status).toBe(304);
  now = new Date(NOW.getTime() + 60_000);
  const expired = await read(cookie, changedTag);
  expect(expired.status).toBe(200); expect(expired.headers.get('etag')).not.toBe(changedTag);
  // The Crew row's age follows a status change, not only the task's creation.
  expect(store.cancelTask('saved-work', now)).toEqual({ ok: true });
  expect((await fresh(cookie)).workspace.crew.find(item => item.id === 'saved-work')?.updatedAt).toBe(now.toISOString());
});

test('quiet heartbeat renewal cannot extend a previously issued liveness deadline', async () => {
  store.raw().prepare(`INSERT INTO runner(name,host,credential_hash,capacity,registered_at,heartbeat_at)
    VALUES ('worker','host','hash',1,?,?)`).run(NOW.toISOString(), new Date(NOW.getTime() - 170_000).toISOString());
  const cookie = await login(); const initial = await fresh(cookie);
  store.raw().prepare('UPDATE runner SET heartbeat_at=?').run(new Date(NOW.getTime() - 160_000).toISOString());
  now = new Date(NOW.getTime() + 9_999);
  expect((await read(cookie, initial.etag)).status).toBe(304);
  now = new Date(NOW.getTime() + 10_000);
  expect((await read(cookie, initial.etag)).status).toBe(200);
});

test('receipt reconciliation, task and result reads always execute a fresh projection', async () => {
  store.createTask({ id: 'focused-work', title: 'Read the current task' }, now);
  store.placeTask(store.lookupRef('focused-work')!.id, repo);
  const cookie = await login(); const initial = await fresh(cookie);
  const query = vi.spyOn(workIndex, 'workIndexPage');
  for (const suffix of ['&request=' + 'a'.repeat(32), '&task=focused-work', '&task=focused-work&result=999', '&result=999']) {
    query.mockClear();
    const response = await read(cookie, initial.etag, CHAT + suffix);
    expect(response.status).toBe(200); expect(response.headers.has('etag')).toBe(false);
    expect(query).toHaveBeenCalled();
    const workspace = await response.json() as BrowserWorkspace;
    expect(workspace.version).toBe(1);
  }
});

test('a validator is private to its login session and changing admitted projects invalidates it', async () => {
  const firstCookie = await login(), secondCookie = await login();
  const [first, second] = await Promise.all([fresh(firstCookie), fresh(secondCookie)]);
  expect(first.workspace.csrf).not.toBe(second.workspace.csrf); expect(first.etag).not.toBe(second.etag);
  const [own, other] = await Promise.all([read(firstCookie, first.etag), read(secondCookie, first.etag)]);
  expect(own.status).toBe(304); expect(other.status).toBe(200);
  expect((await other.json() as BrowserWorkspace).csrf).toBe(second.workspace.csrf);
  const extra = join(directory, 'second-repo'); mkdirSync(extra); admitted = [repo, extra];
  const changedCeiling = await read(firstCookie, first.etag);
  expect(changedCeiling.status).toBe(200); expect(changedCeiling.headers.get('etag')).not.toBe(first.etag);
});

test('revoked credentials and changed account access are revalidated before a conditional response', async () => {
  expect(addApprover(store, 'spare-admin', NOW, { name: 'alex', token }).ok).toBe(true);
  const cookie = await login(); const initial = await fresh(cookie);
  expect(store.setAccountProjects('alex', [repo], 'spare-admin', now).ok).toBe(true);
  const invalidSession = await read(cookie, initial.etag);
  expect(invalidSession.status).toBe(303); expect(invalidSession.headers.get('location')).toContain('/login');
  const restrictedCookie = await login();
  expect((await read(restrictedCookie, initial.etag)).status).toBe(403);
  expect(store.setAccountProjects('alex', null, 'spare-admin', now).ok).toBe(true);
  const renewedCookie = await login(); const renewed = await fresh(renewedCookie);
  expect(store.revokeAccount('alex', 'spare-admin', now).ok).toBe(true);
  const revoked = await read(renewedCookie, renewed.etag);
  expect(revoked.status).toBe(303); expect(revoked.headers.get('location')).toContain('/login');
});
