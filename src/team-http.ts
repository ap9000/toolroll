import { adapterPolicy } from "./server/route-policy.js";
import type { IncomingMessage, ServerResponse } from 'node:http';
import { TEAM_OPERATIONS, TEAM_MUTATIONS, teamScopeAllows, type TeamActor, type TeamExecute, type TeamRequest, type TeamResponse } from './team-contract.js';
import { limitWords, type Admission } from './request-budget.js';

export const TEAM_REQUEST_BYTES = 64 * 1024;
/** Account role belongs to HTTP authentication; API tokens carry their own scope. */
export type TeamHttpActor = TeamActor & { role?: 'approver' | 'viewer' };
export type TeamHttpOptions = {
  authenticate: (request: IncomingMessage) => TeamHttpActor | null | Promise<TeamHttpActor | null>;
  /** Recheck the original credential/session and current account, without extending idle expiry. */
  revalidate: (request: IncomingMessage, actor: TeamActor) => boolean;
  authorizeMutation: (request: IncomingMessage, actor: TeamActor) => boolean;
  execute: TeamExecute;
  /** Current, authorized event cursor. null means the audience is no longer available. */
  cursor?: (actor: TeamActor, conversationId?: string) => number | null;
  /** Source admission before credential verification. Streams are charged once when opened. */
  admit?: (request: IncomingMessage) => Admission;
  /** Proved account/token admission, before reading the body or executing any operation. */
  admitAuthenticated?: (request: IncomingMessage, actor: TeamActor) => Admission;
  streamIntervalMs?: number;
  streams?: Set<ServerResponse>;
};
const failure = (code: string, message: string): TeamResponse => ({ version: 1, ok: false, code, message });
function send(response: ServerResponse, status: number, value: TeamResponse, headers: Record<string, string> = {}): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  response.end(JSON.stringify(value));
}
async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > TEAM_REQUEST_BYTES) throw new Error('too-large');
    chunks.push(bytes);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}
function valid(value: unknown): value is TeamRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).every(key => key === 'operation' || key === 'args') &&
    typeof row.operation === 'string' && (TEAM_OPERATIONS as readonly string[]).includes(row.operation) &&
    !!row.args && typeof row.args === 'object' && !Array.isArray(row.args) &&
    !['actor', 'generation', 'authenticatedActor'].some(key => key in (row.args as object));
}

/** Authenticated browser and remote CLI share one operation boundary. Streams
 * are refresh hints only: no model calls, admissions, or completion writes. */
export async function handleTeamHttp(request: IncomingMessage, response: ServerResponse, options: TeamHttpOptions): Promise<boolean> {
  const url = new URL(request.url ?? '/', 'http://standing-orders.local');
  if (url.pathname !== '/api/team' && url.pathname !== '/api/team/events') return false;
  const reject = (status: number, code: string, message: string) => { send(response, status, failure(code, message)); request.resume(); return true; };
  if ([...url.searchParams.keys()].some(key => /token|password|credential|authorization/i.test(key))) return reject(400, 'credentials-in-url', 'Credentials never travel in URLs.');
  const count = request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'authorization').length;
  if (count > 1) return reject(400, 'ambiguous-credentials', 'Send one authorization header.');
  const refuseAdmission = (admitted: Admission): boolean => {
    if (admitted.ok) return false;
    if (admitted.status === 503) return reject(503, 'limits-unavailable', 'Request limits could not be checked; nothing ran. Try again shortly.');
    send(response, 429, failure('rate-limited', limitWords(admitted.limit, admitted.retryAfter)), { 'retry-after': String(admitted.retryAfter) });
    request.resume();
    return true;
  };
  if (options.admit && refuseAdmission(options.admit(request))) return true;
  let actor: TeamHttpActor | null;
  try { actor = await options.authenticate(request); }
  catch { return reject(503, 'authentication-unavailable', 'Sign-in could not be checked.'); }
  if (!actor) return reject(401, 'unauthenticated', 'Sign in to continue.');
  if (options.admitAuthenticated && refuseAdmission(options.admitAuthenticated(request, actor))) return true;
  const policyPrincipal = () => ({ caller: request.headers.authorization ? 'bearer' as const : 'cookie' as const, capability: actor.principal?.scope ?? (actor.role === 'approver' ? 'act' as const : 'read' as const), token: actor.principal !== undefined });
  if (!adapterPolicy(policyPrincipal()).ok) return reject(403, 'read-only', 'Your token reads only. Use an act token for this.');
  const conversationId = url.searchParams.get('conversation') ?? undefined;
  if (url.pathname === '/api/team/events') {
    if (request.method !== 'GET') return reject(405, 'method-not-allowed', 'Use GET for conversation updates.');
    let initial: TeamResponse;
    try { initial = await options.execute(actor, { operation: conversationId ? 'show' : 'list', args: conversationId ? { conversationId } : {} }); }
    catch { return reject(503, 'unavailable', 'Conversation updates are unavailable.'); }
    if (!initial.ok || !initial.snapshot) { send(response, 403, initial); return true; }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-accel-buffering': 'no' });
    options.streams?.add(response);
    let cursor = initial.snapshot.cursor;
    response.write(`id: ${cursor}\nevent: change\ndata: {"cursor":${cursor}}\n\n`);
    let active = false;
    const close = () => { clearInterval(timer); options.streams?.delete(response); response.end(); };
    const revoked = () => { response.write('event: revoked\ndata: {}\n\n'); close(); };
    const tick = async () => {
      if (active || response.destroyed || response.writableEnded) return;
      active = true;
      try {
        if (!options.revalidate(request, actor!)) return revoked();
        let next: number | null;
        if (options.cursor) next = options.cursor(actor!, conversationId);
        else {
          const reply = await options.execute(actor!, { operation: conversationId ? 'show' : 'list', args: conversationId ? { conversationId } : {} });
          next = reply.ok ? reply.snapshot?.cursor ?? null : null;
        }
        if (next === null) return revoked();
        if (next !== cursor) {
          cursor = next;
          // A slow client receives a fresh scoped snapshot on reconnect, never an unbounded replay buffer.
          if (!response.write(`id: ${cursor}\nevent: change\ndata: {"cursor":${cursor}}\n\n`)) close();
        }
      } catch { response.write('event: unavailable\ndata: {}\n\n'); close(); }
      finally { active = false; }
    };
    const timer = setInterval(() => { void tick(); }, options.streamIntervalMs ?? 1_000);
    timer.unref();
    request.once('close', close);
    response.once('close', close);
    return true;
  }
  let input: TeamRequest;
  if (request.method === 'GET') input = { operation: conversationId ? 'show' : 'list', args: conversationId ? { conversationId } : {} };
  else if (request.method === 'POST') {
    if (!options.authorizeMutation(request, actor)) return reject(403, 'csrf', 'Your sign-in changed. Reload before sending.');
    if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') return reject(415, 'invalid-content-type', 'Send application/json.');
    if (Number(request.headers['content-length'] ?? 0) > TEAM_REQUEST_BYTES) return reject(413, 'request-too-large', 'That message is too large.');
    let value: unknown;
    try { value = await body(request); }
    catch (error) { return reject(error instanceof Error && error.message === 'too-large' ? 413 : 400, 'invalid-body', 'Send a valid JSON request within the message limit.'); }
    if (!valid(value)) return reject(400, 'invalid-request', 'Choose a supported operation and its arguments.');
    input = value;
  } else return reject(405, 'method-not-allowed', 'Use GET or POST.');
  if (!options.revalidate(request, actor)) return reject(401, 'unauthenticated', 'Sign in to continue.');
  if (!adapterPolicy(policyPrincipal(), TEAM_MUTATIONS[input.operation] ? "act" : "read").ok || !teamScopeAllows(actor, input.operation)) return reject(403, 'read-only', 'Your token reads only. Use an act token for this.');
  try {
    const result = await options.execute(actor, input);
    send(response, result.ok ? 200 : /forbidden|access|unauthor|member/.test(result.code) ? 403 : 409, result);
  } catch {
    send(response, 502, failure('delivery-unconfirmed', 'The response could not be confirmed. Check saved messages before sending again.'));
  }
  return true;
}
