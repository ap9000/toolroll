import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  SESSION_REQUEST_BYTES, SESSION_RESPONSE_BYTES, isSessionResponse, sessionDescriptor, validateSessionRequest,
  type SessionOperation, type SessionRequests, type SessionResponse,
} from './session-contract.js';
import { limitWords, type Admission } from './request-budget.js';

export type SessionHttpActor = { name: string; generation: number };
export type SessionHttpExecute = <O extends SessionOperation>(actor: SessionHttpActor, operation: O, request: SessionRequests[O]) => Promise<SessionResponse>;
export type SessionHttpOptions = {
  /** Verify the bearer against the current account and installation-wide
   * operator role. Derive both fields here, never from the JSON request.
   * Host, TLS and other server admission checks remain with the caller. */
  authenticate: (request: IncomingMessage) => SessionHttpActor | null | Promise<SessionHttpActor | null>;
  /** The existing live owner's operation. Null means no owner is ready.
   * The service rechecks actor generation and project access at execution. */
  execute: SessionHttpExecute | null;
  /** The bearer request's budget by source (request-budget.ts): charged once, before the credential is checked or a body read. */
  admit?: (request: IncomingMessage) => Admission;
  /** Account admission after successful authentication, before any body read or owner call. */
  admitAuthenticated?: (request: IncomingMessage, actor: SessionHttpActor) => Admission;
};
type Body = { ok: true; value: unknown } | { ok: false; status: number; reason: string; message: string };
type HttpRejection = Omit<SessionResponse, 'operation'> & { operation?: SessionOperation };

function readBody(request: IncomingMessage): Promise<Body> {
  return new Promise(resolve => {
    let size = 0;
    let chunks: Buffer[] = [];
    let settled = false;
    const finish = (result: Body) => {
      if (settled) return;
      settled = true;
      chunks = [];
      resolve(result);
    };
    const cleanup = () => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('aborted', onAborted);
      request.off('error', onError);
      request.off('close', onClose);
    };
    const onData = (chunk: Buffer | string) => {
      // After rejecting an oversized request, drain without retaining it.
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > SESSION_REQUEST_BYTES) finish({ ok: false, status: 413, reason: 'request-too-large', message: 'The session request is too large.' });
      else chunks.push(bytes);
    };
    const onEnd = () => {
      cleanup();
      if (settled) return;
      try {
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        finish({ ok: true, value });
      } catch {
        finish({ ok: false, status: 400, reason: 'invalid-json', message: 'Send a valid UTF-8 JSON request.' });
      }
    };
    const onAborted = () => {
      finish({ ok: false, status: 400, reason: 'incomplete-request', message: 'The session request did not finish arriving.' });
    };
    const onError = () => { onAborted(); cleanup(); };
    const onClose = () => { onAborted(); cleanup(); };
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('aborted', onAborted);
    request.once('error', onError);
    request.once('close', onClose);
    if (request.aborted) onAborted();
  });
}

/** Handle this API family before the browser's form parser or login redirects.
 * This adapter dispatches at most once. It owns no catalog, database or provider. */
export async function handleSessionHttp(request: IncomingMessage, response: ServerResponse, options: SessionHttpOptions): Promise<boolean> {
  const path = (request.url ?? '').split('?')[0] ?? '';
  if (path !== '/api/sessions' && !path.startsWith('/api/sessions/')) return false;
  const match = /^\/api\/sessions\/([a-z]+)$/.exec(request.url ?? '');
  const spec = match?.[1] === undefined ? undefined : sessionDescriptor(match[1]);
  const operation = spec?.operation;
  const write = (status: number, body: string, notSent = false) => {
    if (response.destroyed || response.writableEnded) return;
    response.statusCode = status;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('content-length', Buffer.byteLength(body));
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    if (notSent) response.setHeader('x-standing-orders-session-delivery', 'not-sent');
    else response.removeHeader('x-standing-orders-session-delivery');
    response.end(body);
  };
  const reject = (status: number, reason: string, message: string): true => {
    // No owner call has occurred. This marker is never inferred from an
    // exception, a lost response, or a response too large to deliver.
    const reply: HttpRejection = { version: 1, ...(operation === undefined ? {} : { operation }), ok: false,
      status: 'rejected', delivery: 'not-sent', retry: spec?.mutation === false ? 'safe-read' : 'never', reason, message, nextActions: [] };
    write(status, JSON.stringify(reply), true);
    request.resume();
    return true;
  };
  if (!spec || operation === undefined) return reject(404, 'unsupported-operation', 'This session operation is not supported.');
  if (request.method !== 'POST') {
    response.setHeader('allow', 'POST');
    return reject(405, 'method-not-allowed', 'Session operations require POST.');
  }
  if (request.headers.origin !== undefined) return reject(403, 'browser-request', 'Use the authenticated session client for this operation.');
  const authorizationCount = request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index]?.toLowerCase() === 'authorization').length;
  if (authorizationCount !== 1 || !/^Bearer (.+):(.+)$/.test(request.headers.authorization ?? '')) {
    return reject(401, 'unauthenticated', 'Current operator bearer credentials are required.');
  }
  const refuseAdmission = (admitted: Admission): boolean => {
    if (admitted.ok) return false;
    if (admitted.status === 503) return reject(503, 'limits-unavailable', 'Request limits could not be checked; nothing ran. Try again shortly.');
    response.setHeader('retry-after', String(admitted.retryAfter));
    return reject(429, 'rate-limited', limitWords(admitted.limit, admitted.retryAfter));
  };
  if (options.admit && refuseAdmission(options.admit(request))) return true;
  let actor: SessionHttpActor | null;
  try { actor = await options.authenticate(request); }
  catch { return reject(503, 'authentication-unavailable', 'Operator access could not be checked. Try again after the service is ready.'); }
  if (actor === null || typeof actor.name !== 'string' || !actor.name.trim() || !Number.isSafeInteger(actor.generation) || actor.generation < 1) {
    return reject(401, 'unauthenticated', 'Current operator bearer credentials are required.');
  }
  if (options.admitAuthenticated && refuseAdmission(options.admitAuthenticated(request, actor))) return true;
  const media = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
  if (media !== 'application/json') return reject(415, 'unsupported-media-type', 'Send the session request as application/json.');
  const length = request.headers['content-length'];
  if (length !== undefined && Number(length) > SESSION_REQUEST_BYTES) return reject(413, 'request-too-large', 'The session request is too large.');
  if (options.execute === null) return reject(503, 'session-unavailable', 'The session owner is not ready.');
  const body = await readBody(request);
  if (!body.ok) return reject(body.status, body.reason, body.message);
  const validated = validateSessionRequest(operation, body.value);
  if (!validated.ok) return reject(400, 'invalid-request', validated.message);
  if (request.aborted || response.destroyed) return true;

  const uncertain = (reason: string, message: string): SessionResponse => {
    const sessionId = 'sessionId' in validated.request ? validated.request.sessionId : undefined;
    return { version: 1, operation, ok: false, status: 'uncertain', delivery: 'unknown', retry: 'inspect-first', reason, message,
      nextActions: [{ operation: sessionId ? 'show' : 'list', label: sessionId ? 'Inspect session' : 'Inspect saved sessions', ...(sessionId ? { sessionId } : {}) }] };
  };
  let reply: SessionResponse;
  let encoded: string;
  let status: number;
  try {
    reply = await options.execute(actor, operation, validated.request);
    if (!isSessionResponse(reply, operation)) throw new Error('Invalid owner response');
    encoded = JSON.stringify(reply);
    if (Buffer.byteLength(encoded) > SESSION_RESPONSE_BYTES) {
      reply = uncertain('response-too-large', 'The owner response is too large to deliver. Inspect saved activity before continuing; this request was not retried.');
      encoded = JSON.stringify(reply);
    }
    status = reply.status === 'rejected' ? 409 : reply.status === 'uncertain' ? 502 : reply.status === 'pending' ? 202 : 200;
  } catch {
    reply = uncertain('unconfirmed-response', 'The owner response could not be confirmed. Inspect saved activity before continuing; this request was not retried.');
    encoded = JSON.stringify(reply);
    status = 502;
  }
  write(status, encoded);
  return true;
}
