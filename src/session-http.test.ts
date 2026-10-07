import { createServer, request as httpRequest, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { handleSessionHttp, type SessionHttpOptions } from './session-http.js';
import { SESSION_REQUEST_BYTES, SESSION_RESPONSE_BYTES, isSessionResponse, type SessionResponse } from './session-contract.js';

let server: Server;
let base: string;
let options: SessionHttpOptions;
const actor = { name: 'operator', generation: 7 };
const send = { version: 1, sessionId: 'saved-session', key: 'same_request_key_123', expectedRevision: 3, expectedThreadId: 'native-thread', expectedTurnId: null, prompt: 'Clarify the empty-state message.' };
const headers = { authorization: 'Bearer operator:test-token', 'content-type': 'application/json' };
const session = { id: 'saved-session', repo: '/admitted/project', title: 'Improve empty-state copy', status: 'working', nativeThreadId: 'native-thread', turnId: 'native-turn', revision: 4 };
const success = (): SessionResponse => ({ version: 1, operation: 'send', ok: true, status: 'succeeded', delivery: 'confirmed', retry: 'inspect-first', message: 'Message delivered.', nextActions: [{ operation: 'show', label: 'Inspect session', sessionId: session.id }], result: { session, receipt: { key: send.key, status: 'accepted' } } });
const post = (body: unknown = send, extraHeaders: Record<string, string> = {}) => fetch(`${base}/api/sessions/send`, { method: 'POST', headers: { ...headers, ...extraHeaders }, body: typeof body === 'string' ? body : JSON.stringify(body), redirect: 'manual' });
async function rejection(response: Response, status: number, reason: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('location')).toBeNull();
  expect(response.headers.get('x-standing-orders-session-delivery')).toBe('not-sent');
  const body: unknown = await response.json();
  expect(body).toMatchObject({ version: 1, ok: false, status: 'rejected', delivery: 'not-sent', reason });
  expect(isSessionResponse(body, 'send')).toBe(true);
  expect(options.execute).not.toHaveBeenCalled();
}

beforeEach(async () => {
  options = { authenticate: vi.fn(() => actor), execute: vi.fn(async () => success()) };
  server = createServer((request, response) => {
    void handleSessionHttp(request, response, options).then(handled => {
      if (!handled) { response.statusCode = 418; response.end('outside sessions'); }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No HTTP address');
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

test('POST calls the shared owner once with server-derived actor and the exact validated identity', async () => {
  options.admit = vi.fn(() => ({ ok: true }));
  options.admitAuthenticated = vi.fn(() => ({ ok: true }));
  const response = await post(send, { 'content-type': 'application/json; charset=utf-8' });
  expect(response.status).toBe(200);
  expect(response.headers.get('x-standing-orders-session-delivery')).toBeNull();
  expect(await response.json()).toEqual(success());
  expect(options.authenticate).toHaveBeenCalledTimes(1);
  expect(options.admit).toHaveBeenCalledTimes(1);
  expect(options.admitAuthenticated).toHaveBeenCalledExactlyOnceWith(expect.anything(), actor);
  expect(options.execute).toHaveBeenCalledExactlyOnceWith(actor, 'send', send);
});

test.each(['source', 'account'] as const)('%s admission refuses before body parsing or owner execution', async stage => {
  const denied = { ok: false as const, status: 429 as const, limit: 'per-minute' as const, retryAfter: 19 };
  options.admit = vi.fn(() => stage === 'source' ? denied : { ok: true as const });
  options.admitAuthenticated = vi.fn(() => denied);
  const response = await post('{invalid');
  expect(response.headers.get('retry-after')).toBe('19');
  await rejection(response, 429, 'rate-limited');
  expect(options.admit).toHaveBeenCalledTimes(1);
  expect(options.authenticate).toHaveBeenCalledTimes(stage === 'source' ? 0 : 1);
  expect(options.admitAuthenticated).toHaveBeenCalledTimes(stage === 'source' ? 0 : 1);
  if (stage === 'account') expect(options.admitAuthenticated).toHaveBeenCalledExactlyOnceWith(expect.anything(), actor);
});

test('unproved identities never spend an account allowance', async () => {
  options.authenticate = vi.fn(() => null);
  options.admit = vi.fn(() => ({ ok: true }));
  options.admitAuthenticated = vi.fn(() => ({ ok: true }));
  await rejection(await post(), 401, 'unauthenticated');
  expect(options.admit).toHaveBeenCalledTimes(1);
  expect(options.authenticate).toHaveBeenCalledTimes(1);
  expect(options.admitAuthenticated).not.toHaveBeenCalled();
});

test('the API owns unsupported paths without falling through to browser redirects', async () => {
  for (const path of ['/api/sessions', '/api/sessions/unknown', '/api/sessions/send/', '/api/sessions/send?actor=operator']) {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers, body: '{}', redirect: 'manual' });
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('x-standing-orders-session-delivery')).toBe('not-sent');
    expect(response.headers.get('location')).toBeNull();
    expect(await response.json()).toMatchObject({ ok: false, delivery: 'not-sent', reason: 'unsupported-operation' });
  }
  expect((await fetch(`${base}/outside`)).status).toBe(418);
  expect(options.authenticate).not.toHaveBeenCalled();
  expect(options.execute).not.toHaveBeenCalled();
});

test('GET cannot dispatch an operation', async () => {
  const response = await fetch(`${base}/api/sessions/send`, { headers, redirect: 'manual' });
  expect(response.headers.get('allow')).toBe('POST');
  await rejection(response, 405, 'method-not-allowed');
  expect(options.authenticate).not.toHaveBeenCalled();
});

test('cookie-only and Origin-bearing calls are rejected before authentication', async () => {
  await rejection(await fetch(`${base}/api/sessions/send`, { method: 'POST', headers: { cookie: 'standing-orders=browser-session', 'content-type': 'application/json' }, body: JSON.stringify(send) }), 401, 'unauthenticated');
  await rejection(await post(send, { origin: 'https://console.example' }), 403, 'browser-request');
  await rejection(await post(send, { origin: '' }), 403, 'browser-request');
  expect(options.authenticate).not.toHaveBeenCalled();
});

test('revoked or restricted bearer credentials fail closed without echoing credential or auth errors', async () => {
  options.authenticate = vi.fn(() => null);
  await rejection(await post(), 401, 'unauthenticated');
  options.authenticate = vi.fn(() => { throw new Error('private auth diagnostic and test-token'); });
  const response = await post();
  const clone = response.clone();
  await rejection(response, 503, 'authentication-unavailable');
  expect(await clone.text()).not.toContain('private auth diagnostic');
});

test('malformed JSON, wrong media, forged actor fields and incomplete operation fields never dispatch', async () => {
  await rejection(await post('{broken'), 400, 'invalid-json');
  await rejection(await post(send, { 'content-type': 'application/json-incorrect' }), 415, 'unsupported-media-type');
  await rejection(await post({ ...send, actor: { name: 'other', generation: 1 } }), 400, 'invalid-request');
  await rejection(await post({ version: 1, prompt: send.prompt }), 400, 'invalid-request');
});

test('declared and streamed oversized requests stop before owner dispatch', async () => {
  await rejection(await post(' '.repeat(SESSION_REQUEST_BYTES + 1)), 413, 'request-too-large');
  const result = await new Promise<{ status: number; delivery?: string | string[]; body: string }>((resolve, reject) => {
    const request = httpRequest(`${base}/api/sessions/send`, { method: 'POST', headers }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, ...(response.headers['x-standing-orders-session-delivery'] === undefined ? {} : { delivery: response.headers['x-standing-orders-session-delivery'] }), body }));
    });
    request.on('error', reject);
    request.write(' '.repeat(SESSION_REQUEST_BYTES));
    request.end('x');
  });
  expect(result.status).toBe(413);
  expect(result.delivery).toBe('not-sent');
  expect(JSON.parse(result.body)).toMatchObject({ delivery: 'not-sent', reason: 'request-too-large' });
  expect(options.execute).not.toHaveBeenCalled();
});

test('an absent owner produces an explicit pre-dispatch refusal', async () => {
  options.execute = null;
  const response = await post();
  expect(response.status).toBe(503);
  expect(response.headers.get('x-standing-orders-session-delivery')).toBe('not-sent');
  expect(await response.json()).toMatchObject({ status: 'rejected', delivery: 'not-sent', reason: 'session-unavailable' });
});

test('an authoritative owner refusal stays distinct from an adapter pre-dispatch rejection', async () => {
  const refusal: SessionResponse = { version: 1, operation: 'send', ok: false, status: 'rejected', delivery: 'not-sent', retry: 'never', reason: 'not-admitted', message: 'Current operator access is required.', nextActions: [] };
  options.execute = vi.fn(async () => refusal);
  const response = await post();
  expect(response.status).toBe(409);
  expect(response.headers.get('x-standing-orders-session-delivery')).toBeNull();
  expect(await response.json()).toEqual(refusal);
  expect(options.execute).toHaveBeenCalledTimes(1);
});

test('execution exceptions and invalid owner responses are uncertain and never retried', async () => {
  for (const execute of [vi.fn(async () => { throw new Error('private provider diagnostic'); }), vi.fn(async () => ({ ...success(), operation: 'stop' } as SessionResponse))]) {
    options.execute = execute;
    const response = await post();
    expect(response.status).toBe(502);
    expect(response.headers.get('x-standing-orders-session-delivery')).toBeNull();
    const body = await response.json();
    expect(isSessionResponse(body, 'send')).toBe(true);
    expect(body).toMatchObject({ status: 'uncertain', delivery: 'unknown', retry: 'inspect-first', reason: 'unconfirmed-response', nextActions: [{ operation: 'show', sessionId: send.sessionId }] });
    expect(JSON.stringify(body)).not.toContain('private provider diagnostic');
    expect(execute).toHaveBeenCalledTimes(1);
  }
});

test('an oversized owner response becomes complete uncertainty JSON, never a truncated or not-sent response', async () => {
  options.execute = vi.fn(async () => ({ ...success(), result: { ...success().result!, items: [{ id: 'large-item', type: 'message', status: null, text: 'x'.repeat(SESSION_RESPONSE_BYTES) }] } }));
  const response = await post();
  expect(response.status).toBe(502);
  expect(response.headers.get('x-standing-orders-session-delivery')).toBeNull();
  const text = await response.text();
  expect(Buffer.byteLength(text)).toBeLessThan(SESSION_RESPONSE_BYTES);
  expect(Number(response.headers.get('content-length'))).toBe(Buffer.byteLength(text));
  expect(JSON.parse(text)).toMatchObject({ status: 'uncertain', delivery: 'unknown', reason: 'response-too-large' });
  expect(options.execute).toHaveBeenCalledTimes(1);
});

test('disconnecting after dispatch does not replay or relabel the completed owner call', async () => {
  let release!: () => void;
  let entered!: () => void;
  const dispatched = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  options.execute = vi.fn(async () => { entered(); await gate; return success(); });
  const request = httpRequest(`${base}/api/sessions/send`, { method: 'POST', headers });
  request.on('error', () => {});
  request.end(JSON.stringify(send));
  await dispatched;
  const closed = new Promise<void>(resolve => request.once('close', resolve));
  request.destroy();
  await closed;
  release();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(options.execute).toHaveBeenCalledTimes(1);
});


test('an incomplete body disconnects before any owner operation is dispatched', async () => {
  let admitted!: () => void;
  const admission = new Promise<void>(resolve => { admitted = resolve; });
  options.authenticate = vi.fn(() => { admitted(); return actor; });
  const request = httpRequest(`${base}/api/sessions/send`, { method: 'POST', headers: { ...headers, 'content-length': '1000' } });
  request.on('error', () => {});
  request.write('{"version":1');
  await admission;
  const closed = new Promise<void>(resolve => request.once('close', resolve));
  request.destroy();
  await closed;
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(options.execute).not.toHaveBeenCalled();
});
