import { afterEach, describe, expect, test, vi } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { handleTeamHttp, TEAM_REQUEST_BYTES, type TeamHttpOptions } from './team-http.js';
import type { TeamSnapshot } from './team-contract.js';
import { matchRoute } from './server/route-table.js';
import { withEdgePolicy } from './server/route-policy.js';
const snapshot: TeamSnapshot = { leads: [], conversations: [], selected: null, participants: [], messages: [], canManage: false, canSend: false, cursor: 1, truncated: false, projects: [], accounts: [] };
const servers: Server[] = []; const streams = new Set<ServerResponse>();
afterEach(async () => { for (const stream of streams) stream.end(); streams.clear(); for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve())); });
async function fixture(overrides: Partial<TeamHttpOptions> = {}, routePolicy = false) {
  const execute = vi.fn(async () => ({ version: 1 as const, ok: true, code: 'ok', message: 'Saved', snapshot }));
  const options: TeamHttpOptions = { authenticate: request => request.headers.authorization === 'Bearer alex:private' ? { name: 'alex', generation: 2 } : null,
    revalidate: () => true, authorizeMutation: request => request.headers['x-csrf-token'] === 'csrf', execute, streamIntervalMs: 10, streams, ...overrides };
  const server = createServer((request, response) => {
    const handle = () => handleTeamHttp(request, response, options);
    const result = routePolicy ? withEdgePolicy(matchRoute(request.method!, new URL(request.url!, 'http://local').pathname)!, handle) : handle();
    void result.then(handled => { if (!handled) { response.statusCode = 404; response.end(); } });
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('no port');
  return { url: `http://127.0.0.1:${address.port}`, execute };
}
const headers = { authorization: 'Bearer alex:private', 'content-type': 'application/json', 'x-csrf-token': 'csrf' };
describe('shared team transport', () => {
  test.each(['viewer', 'approver'] as const)('route policy derives cookie capability from the authenticated %s role', async role => {
    const actor = { name: 'alex', generation: 2, role };
    const { url, execute } = await fixture({ authenticate: () => actor }, true);
    const cookieHeaders = { 'content-type': 'application/json', 'x-csrf-token': 'csrf' };
    expect((await fetch(url + '/api/team')).status).toBe(200);
    expect((await fetch(url + '/api/team', { method: 'POST', headers: cookieHeaders, body: JSON.stringify({ operation: 'list', args: {} }) })).status).toBe(200);
    execute.mockClear();
    const input = { operation: 'send', args: { conversationId: 'room', requestId: 'cookie-role', text: 'Keep the settings simple.' } };
    const response = await fetch(url + '/api/team', { method: 'POST', headers: cookieHeaders, body: JSON.stringify(input) });
    expect(response.status).toBe(role === 'approver' ? 200 : 403);
    if (role === 'approver') expect(execute).toHaveBeenCalledExactlyOnceWith(actor, input);
    else { expect((await response.json()).code).toBe('read-only'); expect(execute).not.toHaveBeenCalled(); }
  });
  test.each(['read', 'act'] as const)('route policy keeps the API token %s scope authoritative over account role', async scope => {
    const actor = { name: 'alex', generation: 2, role: scope === 'read' ? 'approver' as const : 'viewer' as const,
      principal: { kind: 'person' as const, account: 'alex', generation: 2, scope, tokenId: 'token', projects: null } };
    const { url, execute } = await fixture({ authenticate: () => actor }, true);
    expect((await fetch(url + '/api/team', { headers })).status).toBe(200);
    execute.mockClear();
    const input = { operation: 'send', args: { conversationId: 'room', requestId: 'token-scope', text: 'Keep the settings simple.' } };
    const response = await fetch(url + '/api/team', { method: 'POST', headers, body: JSON.stringify(input) });
    expect(response.status).toBe(scope === 'act' ? 200 : 403);
    if (scope === 'act') expect(execute).toHaveBeenCalledExactlyOnceWith(actor, input);
    else { expect((await response.json()).code).toBe('read-only'); expect(execute).not.toHaveBeenCalled(); }
  });
  test.each(['source', 'account'] as const)('%s admission refuses before body parsing or execution', async stage => {
    const authenticate = vi.fn(() => ({ name: 'alex', generation: 2 }));
    const denied = { ok: false as const, status: 429 as const, limit: 'per-minute' as const, retryAfter: 19 };
    const admit = vi.fn(() => stage === 'source' ? denied : { ok: true as const });
    const admitAuthenticated = vi.fn(() => denied);
    const { url, execute } = await fixture({ authenticate, admit, admitAuthenticated });
    // Invalid JSON would fail parsing if the adapter read it before deciding admission.
    const response = await fetch(url + '/api/team', { method: 'POST', headers, body: '{invalid' });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('19');
    expect(await response.json()).toMatchObject({ code: 'rate-limited' });
    expect(admit).toHaveBeenCalledTimes(1);
    expect(authenticate).toHaveBeenCalledTimes(stage === 'source' ? 0 : 1);
    expect(admitAuthenticated).toHaveBeenCalledTimes(stage === 'source' ? 0 : 1);
    if (stage === 'account') expect(admitAuthenticated.mock.calls[0]?.[1]).toEqual({ name: 'alex', generation: 2 });
    expect(execute).not.toHaveBeenCalled();
  });
  test('unproved identities never reach account admission; a successful read spends each budget once', async () => {
    const authenticate = vi.fn<NonNullable<TeamHttpOptions['authenticate']>>(() => null);
    const admit = vi.fn(() => ({ ok: true as const }));
    const admitAuthenticated = vi.fn(() => ({ ok: true as const }));
    const { url, execute } = await fixture({ authenticate, admit, admitAuthenticated });
    expect((await fetch(url + '/api/team', { headers })).status).toBe(401);
    expect(admitAuthenticated).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    admit.mockClear(); authenticate.mockClear();
    authenticate.mockReturnValue({ name: 'alex', generation: 2 });
    expect((await fetch(url + '/api/team', { headers })).status).toBe(200);
    expect(admit).toHaveBeenCalledTimes(1);
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(admitAuthenticated).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  test('derives actor from authentication and passes a single operation', async () => {
    const { url, execute } = await fixture();
    const input = { operation: 'send', args: { conversationId: 'room', requestId: 'once', text: 'Keep the settings simple.' } };
    const response = await fetch(url + '/api/team', { method: 'POST', headers, body: JSON.stringify(input) });
    expect(response.status).toBe(200); expect(execute).toHaveBeenCalledExactlyOnceWith({ name: 'alex', generation: 2 }, input);
  });
  test('rejects client actor impersonation before executing', async () => {
    const { url, execute } = await fixture();
    const response = await fetch(url + '/api/team', { method: 'POST', headers, body: JSON.stringify({ operation: 'send', args: { actor: 'sam' } }) });
    expect(response.status).toBe(400); expect(execute).not.toHaveBeenCalled();
  });
  test('requires sign-in and a current mutation proof', async () => {
    const { url, execute } = await fixture();
    expect((await fetch(url + '/api/team')).status).toBe(401);
    expect((await fetch(url + '/api/team', { method: 'POST', headers: { authorization: headers.authorization }, body: '{}' })).status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });
  test('bounds request bodies and refuses query-string credentials', async () => {
    const { url, execute } = await fixture();
    expect((await fetch(url + '/api/team?password=private', { headers })).status).toBe(400);
    expect((await fetch(url + '/api/team', { method: 'POST', headers, body: 'x'.repeat(TEAM_REQUEST_BYTES + 1) })).status).toBe(413);
    expect(execute).not.toHaveBeenCalled();
  });
  test('GET opens the same conversation without admitting a turn', async () => {
    const { url, execute } = await fixture();
    expect((await fetch(url + '/api/team?conversation=room', { headers })).status).toBe(200);
    expect(execute).toHaveBeenCalledExactlyOnceWith({ name: 'alex', generation: 2 }, { operation: 'show', args: { conversationId: 'room' } });
  });
  test('checks revoked authority again after receiving the body', async () => {
    const { url, execute } = await fixture({ revalidate: () => false });
    expect((await fetch(url + '/api/team', { method: 'POST', headers, body: JSON.stringify({ operation: 'list', args: {} }) })).status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });
  test('uncertain delivery does not repeat a mutation', async () => {
    const execute = vi.fn(async () => { throw Error('reply lost'); });
    const { url } = await fixture({ execute });
    const response = await fetch(url + '/api/team', { method: 'POST', headers, body: JSON.stringify({ operation: 'send', args: { conversationId: 'room', requestId: 'one', text: 'Hello' } }) });
    expect(response.status).toBe(502); expect((await response.json()).code).toBe('delivery-unconfirmed'); expect(execute).toHaveBeenCalledTimes(1);
  });
  test('idle streams send no repeated messages and revalidate revoked access', async () => {
    let allowed = true; let cursor = 1;
    const { url, execute } = await fixture({ revalidate: () => allowed, cursor: () => cursor });
    const response = await fetch(url + '/api/team/events?conversation=room', { headers });
    const reader = response.body!.getReader(), decode = new TextDecoder();
    expect(decode.decode((await reader.read()).value)).toContain('id: 1');
    cursor = 2;
    expect(decode.decode((await reader.read()).value)).toContain('id: 2');
    allowed = false;
    expect(decode.decode((await reader.read()).value)).toContain('event: revoked');
    expect((await reader.read()).done).toBe(true); expect(execute).toHaveBeenCalledTimes(1);
  });
});
