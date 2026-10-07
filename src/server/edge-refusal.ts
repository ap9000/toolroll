import type { IncomingMessage,ServerResponse } from 'node:http';
import { sessionDescriptor } from '../session-contract.js';
import { ROUTES,type RouteDeclaration } from './route-table.js';

export function isEdgeAddress(path: string): boolean {
  return ROUTES.some(row => row.stage === 'edge' && new RegExp(row.pattern).test(path))
    || /^\/(?:oauth|hooks|api\/(?:sessions|team|cli))(?:\/|$)/.test(path)
    || path.startsWith('/.well-known/oauth-');
}

/** Preserve each transport's refusal envelope without invoking an undeclared adapter. */
export function refuseEdge(request: IncomingMessage, response: ServerResponse, path: string, declared: RouteDeclaration | null): void {
  request.resume();
  response.statusCode = declared ? 405 : 404;
  let type = 'text/plain; charset=utf-8', body = 'No such address.';
  if (path === '/mcp') {
    response.setHeader('allow', 'POST'); type = 'application/json';
    body = JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'the MCP gateway takes POST only — one JSON-RPC message per request' } });
  } else if (path.startsWith('/api/sessions/')) {
    const spec = sessionDescriptor(path.split('/')[3] ?? '');
    type = 'application/json'; response.setHeader('X-Toolroll-Delivery', 'not-sent');
    if (spec) response.setHeader('allow', 'POST');
    body = JSON.stringify({ version: 1, ...(spec ? { operation: spec.operation } : {}), ok: false, status: 'rejected', delivery: 'not-sent', retry: spec?.mutation === false ? 'safe-read' : 'never', reason: spec ? 'method-not-allowed' : 'unsupported-operation', message: spec ? 'Session operations require POST.' : 'This session operation is not supported.', nextActions: [] });
  } else if (path === '/api/cli' || path.startsWith('/api/team')) {
    type = 'application/json';
    body = JSON.stringify({ ...(path.startsWith('/api/team') ? { version: 1 } : {}), ok: false, code: declared ? 'method-not-allowed' : 'not-found', message: declared ? path === '/api/cli' ? 'Use POST.' : path.endsWith('/events') ? 'Use GET.' : 'Use GET or POST.' : 'No such address.' });
  } else if (path.startsWith('/oauth/') || path.startsWith('/.well-known/oauth-')) {
    type = 'application/json'; body = JSON.stringify({ error: 'invalid_request', error_description: declared ? declared.method === 'POST' ? 'Use POST.' : 'Use GET.' : 'No such address.' });
  } else if (path === '/hooks/telegram') body = 'no';
  else if (path.startsWith('/hooks/form/')) { type = 'text/html; charset=utf-8'; body = ''; }
  else if (path.startsWith('/hooks/')) { type = 'application/json'; body = JSON.stringify({ said: declared ? 'Send a POST.' : 'No such address.' }); }
  else if (path === '/teams/messages') { type = 'application/json'; body = '{}'; }
  else if (path.startsWith('/assets/')) { response.setHeader('allow', 'GET, HEAD'); body = ''; }
  response.setHeader('content-type', type);
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.end(body);
}
