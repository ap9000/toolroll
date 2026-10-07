import { AsyncLocalStorage } from 'node:async_hooks';
import type { Caller,ProjectResolver,RouteDeclaration,RouteScope } from './route-table.js';

export interface RoutePrincipal {
  caller: Caller;
  capability: 'none' | 'read' | 'act';
  viewer?: boolean;
  token?: boolean;
}
export type PolicyResult = { ok: true } | { ok: false; status: 403; reason: 'caller' | 'scope' | 'project' };

/** The row supplies the minimum capability and the project resolver. Passwords/nonces are re-proved by the handler. */
export function evaluateRoutePolicy(route: RouteDeclaration, principal: RoutePrincipal, resolve: (source: ProjectResolver) => boolean, operationScope?: RouteScope): PolicyResult {
  if (!route.callers.includes(principal.caller)) return { ok: false, status: 403, reason: 'caller' };
  const required = route.scope === 'step-up' || operationScope === 'step-up' ? 'step-up'
    : route.scope === 'act' || operationScope === 'act' ? 'act' : route.scope === 'read' || operationScope === 'read' ? 'read' : 'none';
  if (required === 'step-up' && principal.caller !== 'cookie') return { ok: false, status: 403, reason: 'caller' };
  const needsAct = required === 'act' || required === 'step-up';
  const viewerPreference = principal.caller === 'cookie' && route.viewer && principal.viewer === true && principal.token !== true;
  if ((needsAct && principal.capability !== 'act' && !viewerPreference) || (required === 'read' && principal.capability === 'none')) return { ok: false, status: 403, reason: 'scope' };
  if (!resolve(route.project)) return { ok: false, status: 403, reason: 'project' };
  return { ok: true };
}

/** The dispatcher matches once; protocol authentication then checks the same row before operation dispatch. */
const edgePolicy = new AsyncLocalStorage<{ route: RouteDeclaration; caller?: Caller }>();
export function withEdgePolicy<T>(route: RouteDeclaration, run: () => T): T { return edgePolicy.run({ route }, run); }
export function adapterPolicy(principal: RoutePrincipal, scope?: RouteScope, resolve: (source: ProjectResolver) => boolean = source => source === 'none' || source === 'adapter'): PolicyResult {
  const context = edgePolicy.getStore();
  // Standalone protocol adapters retain their own authoritative admission checks.
  if (context === undefined) return { ok: true };
  const checked = evaluateRoutePolicy(context.route, { ...principal, caller: context.caller ?? principal.caller }, resolve, scope);
  if (checked.ok && context.caller === undefined) context.caller = principal.caller;
  return checked;
}
